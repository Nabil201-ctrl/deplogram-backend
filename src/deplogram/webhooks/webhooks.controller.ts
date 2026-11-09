import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';

import { WebhooksService } from './webhooks.service.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import {
  WebhookEndpointDto,
  WebhookRequestDto,
  WebhookTestDto,
  ReplayDto,
  ReplayResultDto,
} from './dto.js';

/**
 * Webhook tester: a capture URL per workspace that records whatever is sent to it,
 * so you can see exactly what a provider (GitHub, Paystack…) sends, and replay it.
 */
@ApiTags('webhooks')
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('endpoint')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get the workspace webhook capture URL' })
  @ApiResponse({ status: 200, description: 'Capture URL', type: WebhookEndpointDto })
  endpoint() {
    return this.webhooks.endpoint();
  }

  @Post('endpoint')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a new capture URL; the old one stops receiving' })
  @ApiResponse({ status: 200, description: 'New capture URL', type: WebhookEndpointDto })
  rotate() {
    return this.webhooks.rotate();
  }

  @Get('requests')
  @HttpCode(200)
  @ApiOperation({ summary: 'Requests captured by the endpoint, newest first (last 50)' })
  @ApiResponse({ status: 200, description: 'Captured requests', type: Object })
  list() {
    return this.webhooks.list();
  }

  @Delete('requests')
  @HttpCode(204)
  @ApiOperation({ summary: 'Clear all captured requests' })
  @ApiResponse({ status: 204, description: 'Requests cleared' })
  clear() {
    this.webhooks.clear();
  }

  @Post('test')
  @HttpCode(201)
  @ApiOperation({ summary: 'Send a sample request to the capture URL' })
  @ApiBody({ type: WebhookTestDto })
  @ApiResponse({ status: 201, description: 'The sample request', type: WebhookRequestDto })
  test(@Body() body: WebhookTestDto) {
    return this.webhooks.test(body.sample);
  }

  @Post('requests/:id/replay')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replay a captured request at a public URL' })
  @ApiParam({ name: 'id', type: String, example: 'wh_abc123' })
  @ApiBody({ type: ReplayDto })
  @ApiResponse({ status: 200, description: 'Replay result', type: ReplayResultDto })
  @ApiResponse({ status: 404, description: 'Request not found' })
  @ApiResponse({ status: 422, description: 'Not a public URL' })
  replay(@Param('id') id: string, @Body() body: ReplayDto) {
    return this.webhooks.replay(id, body.url);
  }
}
