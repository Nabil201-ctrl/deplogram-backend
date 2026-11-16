import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { WebhooksService } from './webhooks.service.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiParam,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import {
  WebhookEndpointDto,
  WebhookRequestDto,
  WebhookTestDto,
  ReplayDto,
  ReplayResultDto,
} from './dto.js';
import { requireUser } from '../auth/require-auth.js';

/**
 * Webhook tester: a capture URL per workspace that records whatever is sent to
 * it, so you can see exactly what a provider (GitHub, Paystack…) sends, and
 * replay it. Scoped to the signed-in user's workspace.
 */
@ApiTags('webhooks')
@ApiCookieAuth('deplogram_session')
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('endpoint')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get the workspace webhook capture URL' })
  @ApiResponse({ status: 200, description: 'Capture URL', type: WebhookEndpointDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async endpoint(@Req() req: Request) {
    const workspaceId = requireUser(req).id;
    return this.webhooks.endpoint(workspaceId);
  }

  @Post('endpoint')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a new capture URL; the old one stops receiving' })
  @ApiResponse({ status: 200, description: 'New capture URL', type: WebhookEndpointDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async rotate(@Req() req: Request) {
    const workspaceId = requireUser(req).id;
    return this.webhooks.rotate(workspaceId);
  }

  @Get('requests')
  @HttpCode(200)
  @ApiOperation({ summary: 'Requests captured by the endpoint, newest first (last 50)' })
  @ApiResponse({ status: 200, description: 'Captured requests', type: Object })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async list(@Req() req: Request) {
    const workspaceId = requireUser(req).id;
    return this.webhooks.list(workspaceId);
  }

  @Delete('requests')
  @HttpCode(204)
  @ApiOperation({ summary: 'Clear all captured requests' })
  @ApiResponse({ status: 204, description: 'Requests cleared' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async clear(@Req() req: Request) {
    const workspaceId = requireUser(req).id;
    await this.webhooks.clear(workspaceId);
  }

  @Post('test')
  @HttpCode(201)
  @ApiOperation({ summary: 'Send a sample request to the capture URL' })
  @ApiBody({ type: WebhookTestDto })
  @ApiResponse({ status: 201, description: 'The sample request', type: WebhookRequestDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async test(@Req() req: Request, @Body() body: WebhookTestDto) {
    const workspaceId = requireUser(req).id;
    return this.webhooks.test(workspaceId, body.sample);
  }

  @Post('requests/:id/replay')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replay a captured request at a public URL' })
  @ApiParam({ name: 'id', type: String, example: 'wh_abc123' })
  @ApiBody({ type: ReplayDto })
  @ApiResponse({ status: 200, description: 'Replay result', type: ReplayResultDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  @ApiResponse({ status: 422, description: 'Not a public URL' })
  async replay(@Req() req: Request, @Param('id') id: string, @Body() body: ReplayDto) {
    const workspaceId = requireUser(req).id;
    return this.webhooks.replay(workspaceId, id, body.url);
  }
}
