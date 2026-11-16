import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { DatabaseService } from '../database/database.service.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiParam,
  ApiCookieAuth,
} from '@nestjs/swagger';
import {
  ChangePasswordDto,
  RecoveryCodesDto,
  SessionDto,
  SecurityOverviewDto,
  TwoFactorSetupDto,
} from './dto.js';
import { requireUser } from '../auth/require-auth.js';

@ApiTags('me')
@ApiCookieAuth('deplogram_session')
@Controller('v1/me')
export class SecurityController {
  constructor(private readonly db: DatabaseService) {}

  private viewer(req: Request) {
    return requireUser(req);
  }

  @Get('security')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get security overview (password, 2FA, sessions)' })
  @ApiResponse({ status: 200, description: 'Security overview', type: SecurityOverviewDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async getSecurity(@Req() req: Request): Promise<SecurityOverviewDto> {
    const viewer = this.viewer(req);
    return this.db.getSecurityOverview(viewer.id);
  }

  @Post('password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Change the account password' })
  @ApiBody({ type: ChangePasswordDto })
  @ApiResponse({ status: 204, description: 'Password changed' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 400, description: 'Current password is incorrect' })
  async changePassword(@Req() req: Request, @Body() body: ChangePasswordDto): Promise<void> {
    const viewer = this.viewer(req);
    try {
      await this.db.changePassword(viewer.id, body.current, body.next);
    } catch {
      throw new BadRequestException('Current password is incorrect');
    }
  }

  @Post('two-factor/setup')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate a two-factor setup secret and otpauth URL' })
  @ApiResponse({ status: 200, description: 'Two-factor setup data', type: TwoFactorSetupDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async setupTwoFactor(@Req() req: Request): Promise<TwoFactorSetupDto> {
    const viewer = this.viewer(req);
    return this.db.setupTwoFactor(viewer.id);
  }

  @Post('two-factor/enable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Enable two-factor authentication with a verification code' })
  @ApiBody({ schema: { properties: { code: { type: 'string' } }, required: ['code'] } })
  @ApiResponse({ status: 200, description: 'Recovery codes', type: RecoveryCodesDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 400, description: 'Invalid verification code' })
  async enableTwoFactor(@Req() req: Request, @Body() body: { code: string }): Promise<RecoveryCodesDto> {
    const viewer = this.viewer(req);
    try {
      return await this.db.enableTwoFactor(viewer.id, body.code);
    } catch {
      throw new BadRequestException('Invalid verification code');
    }
  }

  @Post('two-factor/disable')
  @HttpCode(204)
  @ApiOperation({ summary: 'Disable two-factor authentication with a verification code' })
  @ApiBody({ schema: { properties: { code: { type: 'string' } }, required: ['code'] } })
  @ApiResponse({ status: 204, description: 'Two-factor disabled' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 400, description: 'Invalid verification code' })
  async disableTwoFactor(@Req() req: Request, @Body() body: { code: string }): Promise<void> {
    const viewer = this.viewer(req);
    try {
      await this.db.disableTwoFactor(viewer.id, body.code);
    } catch {
      throw new BadRequestException('Invalid verification code');
    }
  }

  @Post('two-factor/recovery-codes')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate a new set of two-factor recovery codes' })
  @ApiResponse({ status: 200, description: 'New recovery codes', type: RecoveryCodesDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async newRecoveryCodes(@Req() req: Request): Promise<RecoveryCodesDto> {
    const viewer = this.viewer(req);
    return this.db.newRecoveryCodes(viewer.id);
  }

  @Get('sessions')
  @HttpCode(200)
  @ApiOperation({ summary: 'List the signed-in user\'s active sessions' })
  @ApiResponse({ status: 200, description: 'User sessions', type: [SessionDto] })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async getSessions(@Req() req: Request): Promise<{ items: SessionDto[] }> {
    const viewer = this.viewer(req);
    return { items: await this.db.getSessions(viewer.id) };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'End a single session by its token' })
  @ApiParam({ name: 'id', type: String, example: 'sess_abc123' })
  @ApiResponse({ status: 204, description: 'Session ended' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async endSession(@Req() req: Request, @Param('id') id: string): Promise<void> {
    const viewer = this.viewer(req);
    const currentToken = req.cookies?.['deplogram_session'] ?? null;
    if (id === currentToken) {
      throw new BadRequestException('Cannot end your current session.');
    }
    const session = (await this.db.getSessions(viewer.id)).find((s) => s.id === id);
    if (!session) throw new BadRequestException('That session does not exist.');
    await this.db.endSession(id);
  }

  @Delete('sessions')
  @HttpCode(204)
  @ApiOperation({ summary: 'End every session except the current one' })
  @ApiResponse({ status: 204, description: 'Other sessions ended' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async endOtherSessions(@Req() req: Request): Promise<void> {
    const viewer = this.viewer(req);
    const currentToken = req.cookies?.['deplogram_session'] ?? null;
    await this.db.endOtherSessions(currentToken ?? '');
  }
}
