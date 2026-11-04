import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsBoolean, IsNotEmpty, IsEnum, IsOptional, MinLength, MaxLength } from 'class-validator';

export class AccountPreferencesDto {
  @ApiProperty({ example: 'nextjs' })
  @IsString()
  defaultRuntime: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  deploymentEmails: boolean;

  @ApiProperty({ example: true })
  @IsBoolean()
  productUpdates: boolean;
}

export class AccountSettingsDto {
  @ApiProperty({ example: 'Sam Rivera' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'sam@example.com' })
  @IsString()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ type: AccountPreferencesDto })
  preferences: AccountPreferencesDto;
}

// ── Security ──────────────────────────────────────────────────────────────────

export class SecurityOverviewDto {
  @ApiPropertyOptional({ example: '2026-10-20T03:11:53.675Z' })
  @IsOptional()
  @IsString()
  passwordChangedAt: string | null;

  @ApiProperty({ type: Object })
  twoFactor: {
    enabled: boolean;
    enabledAt: string | null;
    recoveryCodesLeft: number;
  };
}

export class SessionDto {
  @ApiProperty({ example: 'sess_abc123' })
  id: string;

  @ApiProperty({ example: 'Chrome' })
  browser: string;

  @ApiProperty({ example: 'macOS' })
  os: string;

  @ApiProperty({ example: 'desktop', enum: ['desktop', 'mobile'] })
  device: 'desktop' | 'mobile';

  @ApiPropertyOptional({ example: 'Lagos, NG' })
  @IsOptional()
  @IsString()
  location: string | null;

  @ApiProperty({ example: '197.211.50.12' })
  ip: string;

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  lastActiveAt: string;

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  createdAt: string;

  @ApiProperty({ example: true })
  current: boolean;
}

export class ChangePasswordDto {
  @ApiProperty({ example: 'current-password' })
  @IsString()
  @IsNotEmpty()
  current: string;

  @ApiProperty({ example: 'new-password-12345678' })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  next: string;
}

export class TwoFactorSetupDto {
  @ApiProperty({ example: 'JBSWY3DPEHPK3PXP' })
  secret: string;

  @ApiProperty({ example: 'otpauth://totp/Deplogram:user@deplogram.app?secret=JBSWY3DPEHPK3PXP' })
  otpauthUrl: string;
}

export class RecoveryCodesDto {
  @ApiProperty({ type: [String] })
  recoveryCodes: string[];
}

// ── Notifications ─────────────────────────────────────────────────────────────

export const NotificationEventIds = [
  'deploy_failed',
  'service_crashed',
  'deploy_succeeded',
  'limit_near',
  'limit_reached',
  'new_sign_in',
  'api_keys',
  'product_updates',
  'tips',
] as const;

export type NotificationEvent = (typeof NotificationEventIds)[number];

export class NotificationSettingsDto {
  @ApiProperty({ example: 'user@deplogram.app' })
  @IsString()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ type: Object, additionalProperties: true })
  events: Record<NotificationEvent, boolean>;

  @ApiProperty({ example: 'weekly', enum: ['off', 'weekly'] })
  @IsEnum(['off', 'weekly'])
  digest: 'off' | 'weekly';
}

export class NotificationUpdateDto {
  @ApiPropertyOptional({ type: Object, additionalProperties: true })
  @IsOptional()
  events?: Partial<Record<NotificationEvent, boolean>>;

  @ApiPropertyOptional({ example: 'weekly', enum: ['off', 'weekly'] })
  @IsOptional()
  @IsEnum(['off', 'weekly'])
  digest?: 'off' | 'weekly';
}

// ── Git ───────────────────────────────────────────────────────────────────────

export class GitInstallationDto {
  @ApiProperty({ example: 12345678 })
  id: number;

  @ApiProperty({ example: 'princeion' })
  account: string;

  @ApiProperty({ example: 'user', enum: ['user', 'organization'] })
  type: 'user' | 'organization';

  @ApiProperty({ example: 'all', enum: ['all', 'selected'] })
  repositorySelection: 'all' | 'selected';

  @ApiProperty({ example: 42 })
  repositories: number;

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  installedAt: string;

  @ApiProperty({ example: 'https://github.com/settings/installations/12345678' })
  settingsUrl: string;
}

export class GitConnectionResultDto {
  @ApiProperty({ example: 'https://github.com/login/oauth/authorize?client_id=...' })
  url: string;
}
