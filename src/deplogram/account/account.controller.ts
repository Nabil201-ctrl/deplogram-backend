import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { DatabaseService } from '../database/database.service.js';
import type { AccountSettings, Viewer } from '../types.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { AccountSettingsDto } from './dto.js';
import { requireUser } from '../auth/require-auth.js';

/**
 * Everything about the signed-in account: its settings and its own deletion.
 * Every endpoint is guarded by the session cookie.
 */
@ApiTags('me')
@ApiCookieAuth('deplogram_session')
@Controller('v1/me')
export class AccountController {
  constructor(private readonly db: DatabaseService) {}

  /** The signed-in viewer, or 401 when nobody is signed in. */
  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'Get the signed-in viewer', description: 'Returns 401 when signed out.' })
  @ApiResponse({ status: 200, description: 'The signed-in user', type: Object })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async me(@Req() req: Request): Promise<Viewer> {
    const user = requireUser(req);
    return user;
  }

  private signedIn(req: Request): void {
    requireUser(req);
  }

  @Get('settings')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get account settings and preferences' })
  @ApiResponse({ status: 200, description: 'Account settings', type: AccountSettingsDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async getSettings(@Req() req: Request): Promise<AccountSettings> {
    this.signedIn(req);
    return this.db.getAccountSettings(requireUser(req).id);
  }

  @Patch('settings')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update account name and preferences' })
  @ApiBody({ type: AccountSettingsDto })
  @ApiResponse({ status: 200, description: 'Updated account settings', type: AccountSettingsDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async updateSettings(@Req() req: Request, @Body() body: AccountSettings): Promise<AccountSettings> {
    this.signedIn(req);
    await this.db.updateAccountSettings(requireUser(req).id, body);
    return this.db.getAccountSettings(requireUser(req).id);
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete the signed-in account' })
  @ApiResponse({ status: 204, description: 'Account deleted' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async deleteAccount(@Req() req: Request): Promise<void> {
    this.signedIn(req);
    await this.db.deleteAccount(requireUser(req).id);
  }
}
