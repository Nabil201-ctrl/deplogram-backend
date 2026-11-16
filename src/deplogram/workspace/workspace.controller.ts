import { Controller, Get, HttpCode, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { DatabaseService } from '../database/database.service.js';
import type { Workspace } from '../types.js';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { WorkspaceDto } from './dto.js';
import { requireUser } from '../auth/require-auth.js';

/** The workspace the signed-in user belongs to. */
@ApiTags('workspace')
@ApiCookieAuth('deplogram_session')
@Controller('v1/workspace')
export class WorkspaceController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'Get the current workspace' })
  @ApiResponse({ status: 200, description: 'Workspace', type: WorkspaceDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async current(@Req() req: Request): Promise<Workspace> {
    const user = requireUser(req);
    return this.db.currentWorkspace(user.id);
  }
}
