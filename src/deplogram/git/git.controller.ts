import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { DatabaseService } from '../database/database.service.js';
import type { GitDetection } from '../types.js';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import {
  GitConnectionDto,
  GitRepositoryDto,
  GitBranchDto,
  GitDetectionDto,
} from './dto.js';
import { GitInstallationDto, GitConnectionResultDto } from '../account/dto.js';
import { requireUser } from '../auth/require-auth.js';

/**
 * GitHub integration: connect a Git account via OAuth, then browse that user's
 * repositories, branches and runtime detection. Scoped to the signed-in user.
 */
@ApiTags('git')
@ApiCookieAuth('deplogram_session')
@Controller('v1/git')
export class GitController {
  constructor(private readonly store: DatabaseService) {}

  @Get('connection')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get the connected GitHub account' })
  @ApiResponse({ status: 200, description: 'Git connection info', type: GitConnectionDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async connection(@Req() req: Request) {
    const userId = requireUser(req).id;
    return this.store.getConnection(userId);
  }

  @Post('connection')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start connecting a GitHub account (returns the authorize URL)' })
  @ApiResponse({ status: 200, description: 'Authorize URL', type: GitConnectionResultDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async connect(@Req() req: Request) {
    const userId = requireUser(req).id;
    return this.store.connectGit(userId);
  }

  @Get('callback')
  @ApiOperation({ summary: 'GitHub OAuth callback' })
  async callback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const { userId, account } = await this.store.githubAuthCallback(code ?? '', state ?? '');
    // Redirect back to the dashboard with the connected account. In production
    // this should point at the frontend origin.
    const redirect = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000';
    return res.redirect(`${redirect}/dashboard/settings/git?connected=1&userId=${encodeURIComponent(userId)}&account=${encodeURIComponent(account)}`);
  }

  @Delete('connection')
  @HttpCode(204)
  @ApiOperation({ summary: 'Disconnect the connected GitHub account' })
  @ApiResponse({ status: 204, description: 'GitHub account disconnected' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async disconnect(@Req() req: Request) {
    const userId = requireUser(req).id;
    await this.store.disconnectGit(userId);
  }

  @Get('installations')
  @HttpCode(200)
  @ApiOperation({ summary: 'List GitHub App installations for the connected account' })
  @ApiResponse({ status: 200, description: 'Installations', type: [GitInstallationDto] })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async installations(@Req() req: Request) {
    const userId = requireUser(req).id;
    return { items: await this.store.getGitInstallations(userId) };
  }

  @Get('repositories')
  @HttpCode(200)
  @ApiOperation({ summary: 'List importable repositories, searchable by name' })
  @ApiQuery({ name: 'q', type: String, required: false, example: 'storefront' })
  @ApiResponse({ status: 200, description: 'Repositories', type: [GitRepositoryDto] })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async repositories(@Req() req: Request, @Query('q') q?: string) {
    const userId = requireUser(req).id;
    return this.store.getRepositories(userId, q);
  }

  @Get('repositories/:repositoryId/branches')
  @HttpCode(200)
  @ApiOperation({ summary: 'List branches with their head commit' })
  @ApiParam({ name: 'repositoryId', type: String, example: 'repo_storefront' })
  @ApiResponse({ status: 200, description: 'Branches', type: [GitBranchDto] })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async branches(@Param('repositoryId') repositoryId: string) {
    return this.store.getBranches(repositoryId);
  }

  @Get('repositories/:repositoryId/detect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Detect the runtime from repository contents' })
  @ApiParam({ name: 'repositoryId', type: String, example: 'repo_storefront' })
  @ApiQuery({ name: 'branch', type: String, required: false, example: 'main' })
  @ApiResponse({ status: 200, description: 'Runtime detection result', type: GitDetectionDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async detect(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
    @Query('branch') branch: string,
  ): Promise<GitDetection> {
    requireUser(req);
    return this.store.detect(repositoryId, branch);
  }
}
