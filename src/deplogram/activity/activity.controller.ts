import { Controller, Get, HttpCode, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { DatabaseService } from '../database/database.service.js';
import type { ActivityFilter, ActivityPage, ActivityType } from '../types.js';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { ActivityPageDto } from './dto.js';
import { requireUser } from '../auth/require-auth.js';

const FILTER_TYPES: Record<string, ActivityType[]> = {
  deploys: ['deployment.started', 'deployment.succeeded', 'deployment.failed', 'deployment.rolled_back'],
  changes: ['project.created', 'project.renamed', 'project.deleted', 'env.updated', 'settings.updated'],
  failures: ['deployment.failed'],
};

/**
 * The activity timeline — deployments started/succeeded/failed/rolled back,
 * projects created/renamed/deleted, variable and settings changes.
 * Cursor-paginated; events are immutable (the audit log).
 * Scoped to the signed-in user's workspace.
 */
@ApiTags('activity')
@ApiCookieAuth('deplogram_session')
@Controller('v1/activity')
export class ActivityController {
  constructor(private readonly store: DatabaseService) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'Get the audit/activity timeline, cursor-paginated' })
  @ApiQuery({ name: 'type', type: String, required: false, enum: ['all', 'deploys', 'changes', 'failures'], example: 'deploys' })
  @ApiQuery({ name: 'project', type: String, required: false, example: 'proj_storefront' })
  @ApiQuery({ name: 'cursor', type: String, required: false, example: 'evt_abc123' })
  @ApiQuery({ name: 'limit', type: Number, required: false, example: 25 })
  @ApiResponse({ status: 200, description: 'Activity page', type: ActivityPageDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async page(
    @Req() req: Request,
    @Query('type') type: ActivityFilter | undefined,
    @Query('project') project: string | undefined,
    @Query('cursor') cursor: string | null,
    @Query('limit') limit: string | undefined,
  ): Promise<ActivityPage> {
    const userId = requireUser(req).id;
    const workspace = await this.store.currentWorkspace(userId);
    const page = await this.store.activityPage(cursor ?? null, limit ? Number(limit) : 25, workspace.id);
    let items = page.items;
    if (type && type !== 'all') {
      const allowed = FILTER_TYPES[type] ?? [];
      items = items.filter((event) => allowed.includes(event.type as ActivityType));
    }
    if (project)
      items = items.filter(
        (event) => event.project?.id === project || event.project?.name === project,
      );
    return { items, nextCursor: page.nextCursor };
  }
}
