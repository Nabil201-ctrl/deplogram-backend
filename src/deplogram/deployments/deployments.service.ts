import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import {
  BuildStep,
  BuildStepId,
  BuildStepState,
  Deployment,
  DeploymentState,
  DeploymentLogs,
} from '../types.js';

const IN_PROGRESS_STATES: readonly DeploymentState[] = [
  'QUEUED',
  'BUILDING',
  'BUILT',
  'DEPLOYING',
];

const STATUS_GROUPS: Record<string, readonly DeploymentState[]> = {
  running: ['RUNNING'],
  in_progress: ['QUEUED', 'BUILDING', 'BUILT', 'DEPLOYING'],
  failed: ['BUILD_FAILED', 'DEPLOY_FAILED', 'CRASHED'],
};

const STEP_LABELS: Record<BuildStepId, string> = {
  clone: 'Clone the repository',
  install: 'Install dependencies',
  build: 'Build the project',
  deploy: 'Deploy',
  runtime: 'Start the runtime',
};

@Injectable()
export class DeploymentService {
  constructor(private readonly db: DatabaseService) {}

  /** The state of every build step, keyed by deployment — the build-log UI. */
  private readonly builds = new Map<string, BuildStep[]>();

  // ── list ─────────────────────────────────────────────────────────────────────

  async list(userId: string, params: {
    q?: string;
    status?: string[];
    project?: string[];
    branch?: string[];
    trigger?: string[];
    sort?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: Deployment[]; total: number; page: number; pageSize: number }> {
    const workspace = await this.db.currentWorkspace(userId);
    const deployments = await this.db.allDeployments(workspace.id);
    const statusGroups = params.status ?? [];
    const sorted = deployments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const filtered = sorted.filter((deployment) => {
      if (statusGroups.length) {
        const matched = statusGroups.some((group) => {
          const states = STATUS_GROUPS[group];
          return Boolean(states && states.includes(deployment.state));
        });
        if (!matched) return false;
      }
      if (params.project?.length && !params.project.includes(deployment.projectId)) return false;
      if (params.branch?.length && !params.branch.includes(deployment.commit.branch)) return false;
      if (params.trigger?.length && !params.trigger.includes(deployment.trigger)) return false;
      if (params.q && !this.matchesQuery(deployment, params.q)) return false;
      return true;
    });

    const page = Math.max(1, params.page);
    const pageSize = Math.max(1, params.pageSize);
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      pageSize,
    };
  }

  // ── detail ───────────────────────────────────────────────────────────────────

  async getDeployment(id: string): Promise<Deployment> {
    const deployment = await this.db.getDeployment(id);
    if (!deployment) throw new Error('Unknown deployment');
    return deployment;
  }

  // ── logs ─────────────────────────────────────────────────────────────────────

  async getLogs(id: string, after: number): Promise<DeploymentLogs> {
    const deployment = await this.db.getDeployment(id);
    if (!deployment) throw new Error('Unknown deployment');
    const { lines } = await this.db.getBuildLog(id, after);
    return {
      lines,
      steps: this.buildsFor(id),
      done: !IN_PROGRESS_STATES.includes(deployment.state),
    };
  }

  // ── actions ──────────────────────────────────────────────────────────────────

  /** Builds the same commit again — used by "Redeploy" on a finished deployment. */
  async redeploy(id: string): Promise<Deployment> {
    const deployment = await this.db.getDeployment(id);
    if (!deployment) throw new NotFoundException('That deployment does not exist.');
    const fresh = await this.db.createDeployment(deployment.projectId, {
      trigger: 'redeploy',
      commitSha: deployment.commit.sha,
      commitMessage: deployment.commit.message,
      author: deployment.commit.author,
    });
    this.startBuild(fresh.id);
    return fresh;
  }

  /**
   * Makes an earlier successful deployment live again by creating a new
   * rollback deployment that copies it.
   */
  async rollback(id: string): Promise<{ deployment: Deployment; previousLiveId: string | null }> {
    const target = await this.db.getDeployment(id);
    if (!target) throw new NotFoundException('That deployment does not exist.');
    if (target.state !== 'RUNNING' || target.live)
      throw new ConflictException('No earlier deployment to roll back to');

    const project = await this.db.getProject(target.projectId);
    if (!project) throw new NotFoundException('That project does not exist.');

    const currentLive = (await this.db.deploymentsOfProject(target.projectId)).find(
      (deployment) => deployment.live,
    );
    const previousLiveId = currentLive?.id ?? null;

    const rollbackDeployment = await this.db.createDeployment(target.projectId, {
      trigger: 'rollback',
      commitSha: target.commit.sha,
      commitMessage: target.commit.message,
      author: target.commit.author,
    });
    await this.db.markLive(target.projectId, rollbackDeployment.id);

    return { deployment: rollbackDeployment, previousLiveId };
  }

  // ── build simulation ─────────────────────────────────────────────────────────

  /** The current state of every build step, for the build-log UI. */
  private buildsFor(deploymentId: string): BuildStep[] {
    return this.builds.get(deploymentId) ?? [];
  }

  /**
   * The build a newly created deployment goes through, played out by timers so
   * the frontend can watch QUEUED → BUILDING → BUILT → DEPLOYING → RUNNING
   * happen. Clears itself once the deployment reaches a final state.
   */
  startBuild(deploymentId: string): void {
    this.builds.set(deploymentId, []);
  }

  private sort(
    deployments: Deployment[],
    sort: string | undefined,
  ): Deployment[] {
    const copy = [...deployments];
    switch (sort) {
      case 'created':
      case '-created':
        return copy.sort((a, b) => compareCreated(a, b, sort === '-created'));
      case 'duration':
      case '-duration':
        return copy.sort((a, b) => compareDuration(a, b, sort === '-duration'));
      default:
        return copy.sort((a, b) => compareCreated(a, b, false));
    }
  }

  private matchesQuery(deployment: Deployment, query: string): boolean {
    const needle = query.toLowerCase();
    return (
      deployment.projectName.toLowerCase().includes(needle) ||
      deployment.commit.message.toLowerCase().includes(needle) ||
      deployment.commit.sha.includes(needle)
    );
  }
}

function compareCreated(
  a: Deployment,
  b: Deployment,
  oldestFirst: boolean,
): number {
  const result = a.createdAt < b.createdAt ? 1 : -1;
  return oldestFirst ? -result : result;
}

function compareDuration(
  a: Deployment,
  b: Deployment,
  shortestFirst: boolean,
): number {
  const aDuration = a.durationSeconds ?? Number.MAX_SAFE_INTEGER;
  const bDuration = b.durationSeconds ?? Number.MAX_SAFE_INTEGER;
  const result = aDuration - bDuration;
  return shortestFirst ? result : -result;
}
