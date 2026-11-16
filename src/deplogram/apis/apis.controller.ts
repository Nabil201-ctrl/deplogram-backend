import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request } from 'express';

import { ApisService } from './apis.service.js';
import type { ApiId } from '../types.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiQuery,
  ApiParam,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import {
  ApiUsageDto,
  ApiRequestsDto,
  TryRequestDto,
  TryResultDto,
  CreatedApiKeyDto,
  NewApiKeyDto,
} from './dto.js';
import { requireUser } from '../auth/require-auth.js';

/**
 * Deplogram's platform APIs (OTP, Email, Image transform, QR): usage, recent
 * requests, "Try it", and API keys. Scoped to the signed-in user.
 */
@ApiTags('apis')
@ApiCookieAuth('deplogram_session')
@Controller('v1/apis')
export class ApisController {
  constructor(private readonly apis: ApisService) {}

  @Get('usage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Usage this period for each platform API' })
  @ApiResponse({ status: 200, description: 'API usage', type: ApiUsageDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async usage(@Req() req: Request) {
    requireUser(req);
    return this.apis.usage();
  }

  @Get('requests')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recent requests to the platform APIs' })
  @ApiQuery({ name: 'api', type: String, required: false, enum: ['otp', 'email', 'images', 'qr'], example: 'otp' })
  @ApiResponse({ status: 200, description: 'Requests', type: ApiRequestsDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async requests(@Req() req: Request, @Query('api') api?: ApiId) {
    requireUser(req);
    return this.apis.requests(api);
  }

  @Post('try')
  @HttpCode(200)
  @ApiOperation({ summary: 'Try a platform API endpoint through the workspace session' })
  @ApiBody({ type: TryRequestDto })
  @ApiResponse({ status: 200, description: 'The result', type: TryResultDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async try(@Req() req: Request, @Body() body: TryRequestDto) {
    requireUser(req);
    return this.apis.try(body);
  }
}

@ApiTags('api-keys')
@ApiCookieAuth('deplogram_session')
@Controller('v1/api-keys')
export class ApiKeysController {
  constructor(private readonly apis: ApisService) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'List the workspace\'s API keys' })
  @ApiResponse({ status: 200, description: 'API keys', type: Object })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async keys(@Req() req: Request) {
    const userId = requireUser(req).id;
    return this.apis.keys(userId);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an API key; the secret is returned once' })
  @ApiBody({ type: NewApiKeyDto })
  @ApiResponse({ status: 201, description: 'The new key plus its secret', type: CreatedApiKeyDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 422, description: 'Name is required' })
  async createKey(@Req() req: Request, @Body() body: NewApiKeyDto) {
    const userId = requireUser(req).id;
    if (!body.name?.trim()) {
      throw new UnprocessableEntityException('Give the key a name.');
    }
    return this.apis.createKey(userId, body.name, body.mode, body.access);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiParam({ name: 'id', type: String, example: 'key_1' })
  @ApiResponse({ status: 204, description: 'Key revoked' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Key not found' })
  async revokeKey(@Req() req: Request, @Param('id') id: string) {
    const userId = requireUser(req).id;
    await this.apis.revokeKey(userId, id);
  }
}
