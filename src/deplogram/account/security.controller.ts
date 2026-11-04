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

import { DeplogramStore } from '../store.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiCookieAuth,
  ApiParam,
} from '@nestjs/swagger';
import {
  ChangePasswordDto,
  RecoveryCodesDto,
  SessionDto,
  SecurityOverviewDto,
  TwoFactorSetupDto,
} from './dto.js';

@ApiTags('me')
@ApiCookieAuth('deplogram_session')
@Controller('v1/me')
export class SecurityController {
  constructor(private readonly store: DeplogramStore) {}

  private requireSignedIn(): void {
    if (!this.store.getViewer())
      throw new UnauthorizedException('No signed-in user');
  }

  @Get('security')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get security overview (password, 2FA, sessions)' })
  @ApiResponse({ status: 200, description: 'Security overview', type: SecurityOverviewDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  getSecurity(): SecurityOverviewDto {
    this.requireSignedIn();
    const viewer = this.store.getViewer()!;
    return this.store.getSecurityOverview(viewer.id);
  }

  @Post('password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Change the account password' })
  @ApiBody({ type: ChangePasswordDto })
  @ApiResponse({ status: 204, description: 'Password changed' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 400, description: 'Current password is incorrect' })
  changePassword(@Body() body: ChangePasswordDto): void {
    this.requireSignedIn();
    const viewer = this.store.getViewer()!;
    try {
      this.store.changePassword(viewer.id, body.current, body.next);
    } catch {
      throw new BadRequestException('Current password is incorrect');
    }
  }

  @Post('two-factor/setup')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate a two-factor setup secret and otpauth URL' })
  @ApiResponse({ status: 200, description: 'Two-factor setup data', type: TwoFactorSetupDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  setupTwoFactor(): TwoFactorSetupDto {
    this.requireSignedIn();
    return this.store.setupTwoFactor();
  }

  @Post('two-factor/enable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Enable two-factor authentication with a verification code' })
  @ApiBody({ schema: { properties: { code: { type: 'string' } }, required: ['code'] } })
  @ApiResponse({ status: 200, description: 'Recovery codes', type: RecoveryCodesDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 400, description: 'Invalid verification code' })
  enableTwoFactor(@Body() body: { code: string }): RecoveryCodesDto {
    this.requireSignedIn();
    try {
      return this.store.enableTwoFactor(body.code);
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
  disableTwoFactor(@Body() body: { code: string }): void {
    this.requireSignedIn();
    try {
      this.store.disableTwoFactor(body.code);
    } catch {
      throw new BadRequestException('Invalid verification code');
    }
  }

  @Post('two-factor/recovery-codes')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate a new set of two-factor recovery codes' })
  @ApiResponse({ status: 200, description: 'New recovery codes', type: RecoveryCodesDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  newRecoveryCodes(): RecoveryCodesDto {
    this.requireSignedIn();
    return this.store.newRecoveryCodes();
  }

  @Get('sessions')
  @HttpCode(200)
  @ApiOperation({ summary: 'List the signed-in user\'s active sessions' })
  @ApiResponse({ status: 200, description: 'User sessions', type: [SessionDto] })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  getSessions(): { items: SessionDto[] } {
    this.requireSignedIn();
    const viewer = this.store.getViewer()!;
    return { items: this.store.getSessions(viewer.id) };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'End a single session by its token' })
  @ApiParam({ name: 'id', type: String, example: 'sess_abc123' })
  @ApiResponse({ status: 204, description: 'Session ended' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  endSession(@Param('id') id: string, @Req() req: Request): void {
    this.requireSignedIn();
    const viewer = this.store.getViewer()!;
    const currentToken = req.cookies?.['deplogram_session'] ?? null;
    if (id === currentToken) {
      throw new BadRequestException('Cannot end your current session.');
    }
    const session = this.store.getSessions(viewer.id).find((s) => s.id === id);
    if (!session) throw new BadRequestException('That session does not exist.');
    this.store.endSession(id);
  }

  @Delete('sessions')
  @HttpCode(204)
  @ApiOperation({ summary: 'End every session except the current one' })
  @ApiResponse({ status: 204, description: 'Other sessions ended' })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  endOtherSessions(@Req() req: Request): void {
    this.requireSignedIn();
    const currentToken = req.cookies?.['deplogram_session'] ?? null;
    this.store.endOtherSessions(currentToken ?? '');
  }
}
