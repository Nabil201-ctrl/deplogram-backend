import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { DatabaseService } from '../database/database.service.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { NotificationSettingsDto, NotificationUpdateDto } from './dto.js';
import { requireUser } from '../auth/require-auth.js';

@ApiTags('me')
@ApiCookieAuth('deplogram_session')
@Controller('v1/me')
export class NotificationsController {
  constructor(private readonly db: DatabaseService) {}

  private viewer(req: Request) {
    return requireUser(req);
  }

  @Get('notifications')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get notification settings' })
  @ApiResponse({ status: 200, description: 'Notification settings', type: NotificationSettingsDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async getNotifications(@Req() req: Request): Promise<NotificationSettingsDto> {
    this.viewer(req);
    return this.db.getNotificationSettings(requireUser(req).id);
  }

  @Patch('notifications')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update notification settings' })
  @ApiBody({ type: NotificationUpdateDto })
  @ApiResponse({ status: 200, description: 'Updated notification settings', type: NotificationSettingsDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async updateNotifications(@Req() req: Request, @Body() body: NotificationUpdateDto): Promise<NotificationSettingsDto> {
    this.viewer(req);
    return this.db.updateNotificationSettings(requireUser(req).id, body);
  }
}
