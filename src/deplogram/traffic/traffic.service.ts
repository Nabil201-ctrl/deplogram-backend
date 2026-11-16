import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { Traffic, TrafficPoint } from '../types.js';

const RECENT_WINDOW_MS = 65 * 1000;

@Injectable()
export class TrafficService {
  constructor(private readonly db: DatabaseService) {}

  /** Every request of the last ~65 seconds across the user's live projects. */
  async current(userId: string): Promise<Traffic> {
    const workspace = await this.db.currentWorkspace(userId);
    const projects = await this.db.listProjects(workspace.id);
    const projectIds = new Set(projects.map((p) => p.id));
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    const requests = (await this.db.getRequests())
      .filter((point) => Date.parse(point.at) >= cutoff && projectIds.has(point.projectId))
      .map(toTrafficPoint);
    const liveDeployments = await this.db.getLiveDeployments();
    const liveProjects = new Set(
      liveDeployments.filter((d) => projectIds.has(d.projectId)).map((d) => d.projectId),
    ).size;
    return { requests, liveProjects: liveProjects };
  }
}

function toTrafficPoint(point: TrafficPoint) {
  return {
    at: point.at,
    projectId: point.projectId,
    error: point.error,
    city: point.city,
    status: point.status,
    latencyMs: point.latencyMs,
    path: point.path,
  };
}
