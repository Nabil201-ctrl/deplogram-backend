import { Controller, Get, HttpCode, Req } from '@nestjs/common';
import type { Request } from 'express';

import { UsageService } from './usage.service.js';
import type { Usage } from '../types.js';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { UsageDto } from './dto.js';
import { requireUser } from '../auth/require-auth.js';

@ApiTags('usage')
@ApiCookieAuth('deplogram_session')
@Controller('v1/usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'Get plan usage and limits for the current period' })
  @ApiResponse({ status: 200, description: 'Usage data', type: UsageDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async current(@Req() req: Request): Promise<Usage> {
    const userId = requireUser(req).id;
    return this.usage.current(userId);
  }
}
