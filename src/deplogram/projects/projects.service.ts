import { ConflictException, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import {
  Deployment,
  DeploymentState,
  EnvVarRecord,
  Metrics,
  MetricsRange,
  Project,
  ProjectSummary,
  ProjectUpdate,
  RuntimeLogs,
} from '../types.js';

const METRICS_RANGES: readonly MetricsRange[] = ['1h', '24h', '7d'];

@Injectable()
export class ProjectsService {
  constructor(private readonly db: DatabaseService) {}

  // ── projects ─────────────────────────────────────────────────────────────────

  async listProjects(userId: string): Promise<ProjectSummary[]> {
    const workspace = await this.db.currentWorkspace(userId);
    const summaries: ProjectSummary[] = [];
    for (const project of await this.db.listProjects(workspace.id)) {
      summaries.push(await this.summarize(project, false));
    }
    return summaries;
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.db.getProject(id);
  }

  async createProject(userId: string, input: {
    name: string;
    repositoryId: string;
    branch: string;
    runtime: string;
    config: {
      buildCommand: string | null;
      startCommand: string | null;
      port: number | null;
      rootDirectory: string | null;
    };
    env: { key: string; value: string }[];
  }): Promise<{ project: ProjectSummary; deployment: Deployment }> {
    const project = await this.db.createProject(userId, input);
    const deployment = await this.db.createDeployment(project.id, {
      trigger: 'git',
      commitSha: randomSha(),
      commitMessage: `deploy ${project.name}`,
      author: { name: 'Ada Lovelace', avatarUrl: null },
    });
    return { project: await this.summarize(project, false), deployment };
  }

  async updateProject(id: string, update: ProjectUpdate): Promise<Project | undefined> {
    return this.db.updateProject(id, {
      name: update.name,
      branch: update.branch,
      config: update.config,
    });
  }

  async deleteProject(id: string): Promise<void> {
    await this.db.deleteProject(id);
  }

  /** Is the name (and therefore the URL) still free within the user's workspace? */
  async checkNameAvailability(userId: string, name: string): Promise<{
    available: boolean;
    url: string;
    suggestion: string | null;
  }> {
    const workspace = await this.db.currentWorkspace(userId);
    for (const project of await this.db.listProjects(workspace.id)) {
      if (project.name === name) {
        return { available: false, url: `${name}.deplogram.app`, suggestion: null };
      }
    }
    return { available: true, url: `${name}.deplogram.app`, suggestion: null };
  }

  // ── environment variables ────────────────────────────────────────────────────

  async getEnvVars(id: string): Promise<EnvVarRecord[]> {
    return this.db.getEnvVars(id);
  }

  async saveEnvVars(
    id: string,
    values: { key: string; value: string | null }[],
  ): Promise<EnvVarRecord[]> {
    return this.db.saveEnvVars(id, values);
  }

  // ── runtime logs ─────────────────────────────────────────────────────────────

  async getRuntimeLogs(projectId: string, after: number): Promise<RuntimeLogs> {
    const project = await this.db.getProject(projectId);
    if (!project) throw new Error('Unknown project');
    const deployment = await this.db.latestDeployment(projectId);
    if (!deployment) throw new Error('Unknown deployment');
    const { lines } = await this.db.getRuntimeLog(deployment.id, after);
    return { lines, live: deployment.live };
  }

  // ── metrics ──────────────────────────────────────────────────────────────────

  async getMetrics(projectId: string, range: string): Promise<Metrics> {
    const project = await this.db.getProject(projectId);
    if (!project) throw new Error('Unknown project');
    const metricsRange: MetricsRange = METRICS_RANGES.includes(
      range as MetricsRange,
    )
      ? (range as MetricsRange)
      : '24h';
    const start = startOfRange(metricsRange);
    const periodRequests = (await this.db.getRequests())
      .filter(
        (point) =>
          point.projectId === projectId &&
          Date.parse(point.at) >= start &&
          Date.parse(point.at) < Date.now(),
      );

    const { summary, series, statuses, paths, memoryLimit } = this.aggregate(
      periodRequests,
      metricsRange,
    );
    return {
      range: metricsRange,
      summary,
      series,
      statuses,
      paths,
      memoryLimit,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async summarize(project: Project, withConfig: boolean): Promise<ProjectSummary | Project> {
    const deployments = await this.db.deploymentsOfProject(project.id);
    const latest = deployments[0];
    const state: DeploymentState = latest ? latest.state : 'QUEUED';
    const url = state === 'RUNNING' && latest ? project.url : null;
    const summary: ProjectSummary = {
      id: project.id,
      name: project.name,
      runtime: project.runtime,
      state,
      url,
      repository: project.repository,
      branch: project.branch,
      updatedAt: project.updatedAt,
      latest: latest
        ? {
            id: latest.id,
            state: latest.state,
            live: latest.live,
            sha: latest.commit.sha,
            message: latest.commit.message,
            createdAt: latest.createdAt,
          }
        : null,
      recent: deployments.slice(0, 10).map((deployment) => deployment.state),
    };
    if (!withConfig) return summary;
    return {
      ...summary,
      createdAt: project.createdAt,
      liveDeploymentId: project.liveDeploymentId,
      envCount: project.env.length,
      config: project.config,
      env: project.env,
    };
  }

  private aggregate(
    requests: import('../types.js').TrafficPoint[],
    range: MetricsRange,
  ) {
    const start = startOfRange(range);
    const bucketSize = bucketSizeOf(range);
    const bucketCount = bucketsOf(range);

    const series = [];
    const latenciesPerBucket: number[][] = [];
    for (let index = 0; index < bucketCount; index += 1) {
      const bucketStart = start + index * bucketSize;
      series.push({
        t: new Date(bucketStart).toISOString(),
        requests: 0,
        errors: 0,
        p50: 0,
        p95: 0,
        cpu: 0,
        memory: 0,
      });
      latenciesPerBucket.push([]);
    }

    let ok = 0;
    let redirect = 0;
    let clientError = 0;
    let serverError = 0;
    const latencies: number[] = [];
    const perPath = new Map<string, { requests: number; p95sum: number[] }>();
    for (const request of requests) {
      const at = new Date(request.at).getTime();
      const index = Math.min(Math.floor((at - start) / bucketSize), bucketCount - 1);
      const point = series[index];
      point.requests += 1;
      if (request.error) {
        point.errors += 1;
        serverError += 1;
      } else {
        ok += 1;
      }
      latencies.push(request.latencyMs);
      latenciesPerBucket[index].push(request.latencyMs);
      const entry = perPath.get(request.path) ?? { requests: 0, p95sum: [] };
      entry.requests += 1;
      entry.p95sum.push(request.latencyMs);
      perPath.set(request.path, entry);
      if (request.status >= 300 && request.status < 400) redirect += 1;
      else if (request.status >= 400 && request.status < 500) clientError += 1;
      else if (request.status >= 500) serverError += 1;
    }
    for (let index = 0; index < series.length; index += 1) {
      const latencies = latenciesPerBucket[index];
      series[index].p50 = percentile(latencies, 50);
      series[index].p95 = percentile(latencies, 95);
    }

    const paths = [...perPath.entries()]
      .map(([path, entry]) => ({
        path,
        requests: entry.requests,
        p95: percentile(entry.p95sum, 95),
      }))
      .sort((a, b) => b.requests - a.requests);

    const total = series.reduce((sum, point) => sum + point.requests, 0);

    return {
      summary: {
        requests: total,
        errorRate: total === 0 ? 0 : (total - ok) / total,
        p95: percentile(latencies, 95),
        uptime: total === 0 ? 1 : ok / total,
      },
      series,
      statuses: { ok, redirect, clientError, serverError },
      paths,
      memoryLimit: 512,
    };
  }
}

function bucketsOf(range: MetricsRange): number {
  return range === '1h' ? 12 : range === '24h' ? 24 : 28;
}

function bucketSizeOf(range: MetricsRange): number {
  return range === '1h'
    ? 5 * 60 * 1000
    : range === '24h'
      ? 60 * 60 * 1000
      : 6 * 60 * 60 * 1000;
}

function startOfRange(range: MetricsRange): number {
  const milliseconds =
    range === '1h'
      ? 60 * 60 * 1000
      : range === '24h'
        ? 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
  return Date.now() - milliseconds;
}

function percentile(values: number[], percent: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(Math.floor((percent / 100) * sorted.length), sorted.length - 1);
  return sorted[index];
}

function randomSha(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(10, '0');
}
