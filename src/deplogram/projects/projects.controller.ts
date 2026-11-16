import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { ProjectsService } from './projects.service.js';
import type { CreateProjectInput, ProjectEnvValues, ProjectUpdate } from '../types.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiCookieAuth,
} from '@nestjs/swagger';
import {
  CreateProjectDto,
  ProjectUpdateDto,
  ProjectEnvValuesDto,
  ProjectDto,
  ProjectSummaryDto,
  NameAvailabilityDto,
  EnvVarRecordDto,
} from './dto.js';
import { requireUser } from '../auth/require-auth.js';

/**
 * Projects and everything about them: the list, their settings, environment
 * variables, runtime logs and metrics. Scoped to the signed-in user's workspace.
 */
@ApiTags('projects')
@ApiCookieAuth('deplogram_session')
@Controller('v1/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'List all projects with their latest deployment state' })
  @ApiResponse({ status: 200, description: 'Project summaries', type: [ProjectSummaryDto] })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async list(@Req() req: Request) {
    const userId = requireUser(req).id;
    return this.projects.listProjects(userId);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a project and start its first deployment' })
  @ApiBody({ type: CreateProjectDto })
  @ApiResponse({ status: 201, description: 'Project and deployment created', type: Object })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 409, description: 'Project name already taken' })
  @ApiResponse({ status: 422, description: 'Repository or branch not found' })
  async create(@Req() req: Request, @Body() body: CreateProjectInput) {
    const userId = requireUser(req).id;
    return this.projects.createProject(userId, body);
  }

  /** Declared before the `:id` route so "name-availability" is not read as an id. */
  @Get('name-availability')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check if a project name/URL is available' })
  @ApiQuery({ name: 'name', type: String, required: true, example: 'storefront' })
  @ApiResponse({ status: 200, description: 'Name availability result', type: NameAvailabilityDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async checkNameAvailability(@Req() req: Request, @Query('name') name: string) {
    const userId = requireUser(req).id;
    return this.projects.checkNameAvailability(userId, name);
  }

  @Get(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get one project with its configuration and variables' })
  @ApiParam({ name: 'id', type: String, example: 'proj_storefront' })
  @ApiResponse({ status: 200, description: 'The project', type: ProjectDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getProject(@Req() req: Request, @Param('id') id: string) {
    requireUser(req);
    const project = await this.projects.getProject(id);
    if (!project) throw new NotFoundException('That project does not exist.');
    return project;
  }

  @Patch(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rename, retarget branch, or change build/start settings' })
  @ApiParam({ name: 'id', type: String, example: 'proj_storefront' })
  @ApiBody({ type: ProjectUpdateDto })
  @ApiResponse({ status: 200, description: 'Updated project', type: ProjectDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async updateProject(@Req() req: Request, @Param('id') id: string, @Body() body: ProjectUpdate) {
    requireUser(req);
    return this.projects.updateProject(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Take a project offline and delete its deployments' })
  @ApiParam({ name: 'id', type: String, example: 'proj_storefront' })
  @ApiResponse({ status: 204, description: 'Project deleted' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async deleteProject(@Req() req: Request, @Param('id') id: string): Promise<void> {
    requireUser(req);
    const project = await this.projects.getProject(id);
    if (!project) throw new NotFoundException('That project does not exist.');
    await this.projects.deleteProject(id);
  }

  @Get(':id/env')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get saved environment variable names (never values)' })
  @ApiParam({ name: 'id', type: String, example: 'proj_storefront' })
  @ApiResponse({ status: 200, description: 'Environment variable records', type: [EnvVarRecordDto] })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getEnv(@Req() req: Request, @Param('id') id: string) {
    requireUser(req);
    const project = await this.projects.getProject(id);
    if (!project) throw new NotFoundException('That project does not exist.');
    return this.projects.getEnvVars(id);
  }

  @Put(':id/env')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace the whole variable set. value:null keeps the saved value.' })
  @ApiParam({ name: 'id', type: String, example: 'proj_storefront' })
  @ApiBody({ type: ProjectEnvValuesDto })
  @ApiResponse({ status: 200, description: 'Saved variable records', type: [EnvVarRecordDto] })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async saveEnv(@Req() req: Request, @Param('id') id: string, @Body() body: ProjectEnvValues) {
    requireUser(req);
    const project = await this.projects.getProject(id);
    if (!project) throw new NotFoundException('That project does not exist.');
    return this.projects.saveEnvVars(id, body);
  }

  @Get(':id/logs')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get the live deployment runtime log' })
  @ApiParam({ name: 'id', type: String, example: 'proj_storefront' })
  @ApiQuery({ name: 'after', type: Number, required: false, example: 0 })
  @ApiResponse({ status: 200, description: 'Runtime log lines', type: Object })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getRuntimeLogs(@Req() req: Request, @Param('id') id: string, @Query('after') after?: string) {
    requireUser(req);
    const project = await this.projects.getProject(id);
    if (!project) throw new NotFoundException('That project does not exist.');
    return this.projects.getRuntimeLogs(id, Number(after ?? 0));
  }

  @Get(':id/metrics')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get traffic, latency and resources for the live deployment' })
  @ApiParam({ name: 'id', type: String, example: 'proj_storefront' })
  @ApiQuery({ name: 'range', type: String, required: false, enum: ['1h', '24h', '7d'], example: '24h' })
  @ApiResponse({ status: 200, description: 'Deployment metrics', type: Object })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getMetrics(@Req() req: Request, @Param('id') id: string, @Query('range') range: string) {
    requireUser(req);
    const project = await this.projects.getProject(id);
    if (!project) throw new NotFoundException('That project does not exist.');
    return this.projects.getMetrics(id, range);
  }
}
