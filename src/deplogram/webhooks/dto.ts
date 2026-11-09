import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class WebhookRequestDto {
  @ApiProperty({ example: 'wh_abc123' })
  @IsString()
  id: string;

  @ApiProperty({ example: 'POST' })
  @IsString()
  method: string;

  @ApiProperty({ example: '/' })
  @IsString()
  path: string;

  @ApiProperty({ example: [['ref', 'newsletter']] })
  query: [string, string][];

  @ApiProperty({ example: [['content-type', 'application/json']] })
  headers: [string, string][];

  @ApiProperty({ example: '{"event":"charge.success"}' })
  @IsString()
  body: string;

  @ApiPropertyOptional({ example: 'application/json' })
  @IsOptional()
  @IsString()
  contentType: string | null;

  @ApiProperty({ example: 214 })
  @IsNumber()
  size: number;

  @ApiProperty({ example: '140.82.115.43' })
  @IsString()
  ip: string;

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  @IsString()
  receivedAt: string;
}

export class WebhookEndpointDto {
  @ApiProperty({ example: 'https://hooks.dpl.app/h/abc123' })
  @IsString()
  url: string;

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  @IsString()
  createdAt: string;
}

export class WebhookTestDto {
  @ApiProperty({ example: 'github-push', enum: ['github-push', 'paystack-charge', 'form'] })
  @IsEnum(['github-push', 'paystack-charge', 'form'])
  @IsNotEmpty()
  sample: 'github-push' | 'paystack-charge' | 'form';
}

export class ReplayDto {
  @ApiProperty({ example: 'https://example.com/webhook' })
  @IsString()
  @IsNotEmpty()
  url: string;
}

export class ReplayResultDto {
  @ApiPropertyOptional({ example: 200 })
  @IsOptional()
  status: number | null;

  @ApiProperty({ example: 180 })
  durationMs: number;

  @ApiPropertyOptional({ example: null })
  @IsOptional()
  @IsString()
  error: string | null;
}
