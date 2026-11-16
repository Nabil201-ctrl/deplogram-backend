import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { Plan, Usage, UsageLimit, UsageLimitId } from '../types.js';

const LIMITS_PER_PLAN: Record<Plan, Omit<UsageLimit, 'used' | 'unit'>[]> = {
  free: [
    { id: 'active_deployments', label: 'Active deployments', limit: 1 },
    { id: 'build_minutes', label: 'Build minutes', limit: 120 },
    { id: 'bandwidth', label: 'Bandwidth', limit: 500 * 1024 * 1024 },
    { id: 'storage', label: 'Storage', limit: 256 * 1024 * 1024 },
  ],
  plus: [
    { id: 'active_deployments', label: 'Active deployments', limit: 5 },
    { id: 'build_minutes', label: 'Build minutes', limit: 1000 },
    { id: 'bandwidth', label: 'Bandwidth', limit: 5 * 1024 * 1024 * 1024 },
    { id: 'storage', label: 'Storage', limit: 2 * 1024 * 1024 * 1024 },
  ],
  pro: [
    { id: 'active_deployments', label: 'Active deployments', limit: 20 },
    { id: 'build_minutes', label: 'Build minutes', limit: 5000 },
    { id: 'bandwidth', label: 'Bandwidth', limit: 50 * 1024 * 1024 * 1024 },
    { id: 'storage', label: 'Storage', limit: 20 * 1024 * 1024 * 1024 },
  ],
  enterprise: [
    { id: 'active_deployments', label: 'Active deployments', limit: 100 },
    { id: 'build_minutes', label: 'Build minutes', limit: 20000 },
    { id: 'bandwidth', label: 'Bandwidth', limit: 500 * 1024 * 1024 * 1024 },
    { id: 'storage', label: 'Storage', limit: 100 * 1024 * 1024 * 1024 },
  ],
};

const DAY_MS = 24 * 60 * 60 * 1000;

function trafficByHour(points: import('../types.js').TrafficPoint[]): number[][] {
  const rows: number[][] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const row: number[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      row.push(0);
    }
    rows.push(row);
  }
  for (const point of points) {
    const date = new Date(point.at);
    const weekday = (date.getUTCDay() + 6) % 7;
    rows[weekday][date.getUTCHours()] += 1;
  }
  return rows;
}

@Injectable()
export class UsageService {
  constructor(private readonly db: DatabaseService) {}

  async current(userId: string): Promise<Usage> {
    const workspace = await this.db.currentWorkspace(userId);
    const plan = workspace.plan;
    const projects = await this.db.listProjects(workspace.id);
    const projectIds = new Set(projects.map((p) => p.id));
    const deployments = await this.db.allDeployments(workspace.id);

    const buildMinutes = Math.round(
      deployments
        .filter((d) => d.durationSeconds)
        .reduce((sum, d) => sum + (d.durationSeconds ?? 0), 0) / 60,
    );
    const storageBytes = projects.reduce((sum, p) => sum + p.env.length, 0);

    const limits = LIMITS_PER_PLAN[plan].map((limit) => {
      const used = this.usedStatic(
        limit.id,
        buildMinutes,
        storageBytes,
        projectIds,
        deployments,
      );
      return { ...limit, used, unit: unitFor(limit.id) };
    });

    const today = new Date();
    const requests: Usage['requests'] = [];
    for (let day = 29; day >= 0; day -= 1) {
      const dayStart = today.getTime() - day * DAY_MS;
      requests.push({
        date: new Date(dayStart).toISOString().slice(0, 10),
        requests: this.countRequests(dayStart, dayStart + DAY_MS, projectIds),
        previous: this.countRequests(
          shiftMonths(dayStart, -1),
          dayStart + DAY_MS,
          projectIds,
        ),
      });
    }

    const builds: Usage['builds'] = [];
    for (let day = 29; day >= 0; day -= 1) {
      const dayStart = today.getTime() - day * DAY_MS;
      builds.push({
        date: new Date(dayStart).toISOString().slice(0, 10),
        succeeded: 0,
        failed: 0,
      });
    }
    for (const deployment of deployments) {
      const index = builds.findIndex(
        (entry) => entry.date === deployment.createdAt.slice(0, 10),
      );
      if (index < 0) continue;
      if (isFailed(deployment.state)) builds[index].failed += 1;
      else builds[index].succeeded += 1;
    }

    const end = periodEnd();
    const start = periodStart();
    const requestsPeriod = (await this.db.getRequests()).filter(
      (point) =>
        Date.parse(point.at) >= start &&
        Date.parse(point.at) < end &&
        projectIds.has(point.projectId),
    );
    let served = 0;
    for (const point of requestsPeriod) {
      if (!point.error) served += 1;
    }

    const byHour = trafficByHour(requestsPeriod);

    return {
      period: {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      },
      limits,
      requests,
      builds,
      bandwidthByProject: this.bandwidthByProject(start, end, projectIds, projects),
      storageByKind: [
        { kind: 'container', bytes: 0 },
        { kind: 'static', bytes: 0 },
      ],
      trafficByHour: byHour,
      uptime: requestsPeriod.length === 0 ? 1 : served / requestsPeriod.length,
    };
  }

  private usedStatic(
    limitId: UsageLimitId,
    buildMinutes: number,
    storageBytes: number,
    _projectIds: Set<string>,
    deployments: import('../types.js').Deployment[],
  ): number {
    switch (limitId) {
      case 'active_deployments':
        return deployments.filter((d) => d.live).length;
      case 'build_minutes':
        return buildMinutes;
      case 'bandwidth':
        return 0;
      case 'storage':
        return storageBytes;
    }
  }

  private countRequests(_start: number, _end: number, _projectIds: Set<string>): number {
    // Request traffic is appended to the access log by the runtime/proxy, not by
    // this dashboard backend. The in-memory engine starts empty per workspace.
    return 0;
  }

  private bandwidthByProject(
    _start: number,
    _end: number,
    _projectIds: Set<string>,
    projects: import('../types.js').Project[],
  ): Usage['bandwidthByProject'] {
    return [];
  }
}

function isFailed(state: string): boolean {
  return state === 'BUILD_FAILED' || state === 'DEPLOY_FAILED' || state === 'CRASHED';
}

function periodStart(): number {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function periodEnd(): number {
  return Date.now();
}

function unitFor(limitId: UsageLimitId): UsageLimit['unit'] {
  if (limitId === 'build_minutes') return 'minutes';
  if (limitId === 'bandwidth' || limitId === 'storage') return 'bytes';
  return 'count';
}

function shiftMonths(dayStart: number, months: number): number {
  const date = new Date(dayStart);
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  return target.getTime();
}
