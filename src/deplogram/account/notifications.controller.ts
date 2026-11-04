import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  UnauthorizedException,
} from '@nestjs/common';

import { DeplogramStore } from '../store.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { NotificationSettingsDto, NotificationUpdateDto } from './dto.js';

@ApiTags('me')
@ApiCookieAuth('deplogram_session')
@Controller('v1/me')
export class NotificationsController {
  constructor(private readonly store: DeplogramStore) {}

  private requireSignedIn(): void {
    if (!this.store.getViewer())
      throw new UnauthorizedException('No signed-in user');
  }

  @Get('notifications')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get notification settings' })
  @ApiResponse({ status: 200, description: 'Notification settings', type: NotificationSettingsDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  getNotifications(): NotificationSettingsDto {
    this.requireSignedIn();
    return this.store.getNotificationSettings();
  }

  @Patch('notifications')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update notification settings' })
  @ApiBody({ type: NotificationUpdateDto })
  @ApiResponse({ status: 200, description: 'Updated notification settings', type: NotificationSettingsDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  updateNotifications(@Body() body: NotificationUpdateDto): NotificationSettingsDto {
    this.requireSignedIn();
    return this.store.updateNotificationSettings(body);
  }
}
