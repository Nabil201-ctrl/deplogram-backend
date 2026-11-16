import { Controller, Get, HttpCode, Req } from '@nestjs/common';
import type { Request } from 'express';

import { TrafficService } from './traffic.service.js';
import type { Traffic } from '../types.js';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { TrafficDto } from './dto.js';
import { requireUser } from '../auth/require-auth.js';

@ApiTags('traffic')
@ApiCookieAuth('deplogram_session')
@Controller('v1/traffic')
export class TrafficController {
  constructor(private readonly traffic: TrafficService) {}

  /** Every request of the last ~65 seconds across the user's live projects. */
  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'Get recent traffic across live projects' })
  // @ts-ignore - isolatedModules + emitDecoratorMetadata; @nestjs/swagger needs the class constructor
  @ApiResponse({ status: 200, description: 'Traffic points', type: TrafficDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async current(@Req() req: Request): Promise<Traffic> {
    const userId = requireUser(req).id;
    return this.traffic.current(userId);
  }
}
