import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';

import { ApisService } from './apis.service.js';
import type { ApiId } from '../types.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiQuery,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import {
  ApiUsageDto,
  ApiRequestsDto,
  TryRequestDto,
  TryResultDto,
  CreatedApiKeyDto,
  NewApiKeyDto,
} from './dto.js';

/**
 * Deplogram's platform APIs (OTP, Email, Image transform, QR): usage, recent
 * requests, "Try it", and API keys.
 */
@ApiTags('apis')
@Controller('v1/apis')
export class ApisController {
  constructor(private readonly apis: ApisService) {}

  @Get('usage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Usage this period for each platform API' })
  @ApiResponse({ status: 200, description: 'API usage', type: ApiUsageDto })
  usage() {
    return this.apis.usage();
  }

  @Get('requests')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recent requests to the platform APIs' })
  @ApiQuery({ name: 'api', type: String, required: false, enum: ['otp', 'email', 'images', 'qr'], example: 'otp' })
  @ApiResponse({ status: 200, description: 'Requests', type: ApiRequestsDto })
  requests(@Query('api') api?: ApiId) {
    return this.apis.requests(api);
  }

  @Post('try')
  @HttpCode(200)
  @ApiOperation({ summary: 'Try a platform API endpoint through the workspace session' })
  @ApiBody({ type: TryRequestDto })
  @ApiResponse({ status: 200, description: 'The result', type: TryResultDto })
  try(@Body() body: TryRequestDto) {
    return this.apis.try(body);
  }
}

@ApiTags('api-keys')
@Controller('v1/api-keys')
export class ApiKeysController {
  constructor(private readonly apis: ApisService) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'List the workspace\'s API keys' })
  @ApiResponse({ status: 200, description: 'API keys', type: Object })
  keys() {
    return this.apis.keys();
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an API key; the secret is returned once' })
  @ApiBody({ type: NewApiKeyDto })
  @ApiResponse({ status: 201, description: 'The new key plus its secret', type: CreatedApiKeyDto })
  @ApiResponse({ status: 422, description: 'Name is required' })
  createKey(@Body() body: NewApiKeyDto) {
    if (!body.name?.trim()) {
      throw new UnprocessableEntityException('Give the key a name.');
    }
    return this.apis.createKey(body.name, body.mode, body.access);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiParam({ name: 'id', type: String, example: 'key_1' })
  @ApiResponse({ status: 204, description: 'Key revoked' })
  @ApiResponse({ status: 404, description: 'Key not found' })
  revokeKey(@Param('id') id: string) {
    this.apis.revokeKey(id);
  }
}
