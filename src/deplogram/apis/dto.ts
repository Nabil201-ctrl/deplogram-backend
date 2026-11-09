import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class ApiKeyDto {
  @ApiProperty({ example: 'key_1' })
  @IsString()
  id: string;

  @ApiProperty({ example: 'orders-api production' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'dpl_live_3fk2' })
  @IsString()
  prefix: string;

  @ApiProperty({ example: 'live', enum: ['live', 'test'] })
  @IsEnum(['live', 'test'])
  mode: 'live' | 'test';

  @ApiProperty({ type: [String], example: ['otp', 'email'] })
  @IsArray()
  access: string[];

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  @IsString()
  createdAt: string;

  @ApiPropertyOptional({ example: '2026-10-20T03:11:53.675Z' })
  @IsOptional()
  @IsString()
  lastUsedAt: string | null;

  @ApiProperty({ example: 'Sam Rivera' })
  @IsString()
  createdBy: string;
}

export class CreatedApiKeyDto extends ApiKeyDto {
  @ApiProperty({ example: 'dpl_live_3fk2abcdef…' })
  @IsString()
  secret: string;
}

export class NewApiKeyDto {
  @ApiProperty({ example: 'Signup flow' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'live', enum: ['live', 'test'] })
  @IsEnum(['live', 'test'])
  mode: 'live' | 'test';

  @ApiProperty({ type: [String], example: ['otp', 'email'] })
  @IsArray()
  access: string[];
}

export class ApiUsageApiDto {
  @ApiProperty({ example: 'otp', enum: ['otp', 'email', 'images', 'qr'] })
  @IsEnum(['otp', 'email', 'images', 'qr'])
  id: string;

  @ApiProperty({ example: 120 })
  @IsNumber()
  used: number;

  @ApiProperty({ example: 500 })
  @IsNumber()
  limit: number;

  @ApiProperty({ example: 0.988 })
  @IsNumber()
  successRate: number;

  @ApiProperty({ example: 412 })
  @IsNumber()
  p50Ms: number;

  @ApiProperty()
  daily: { date: string; requests: number; errors: number }[];
}

export class ApiUsageDto {
  @ApiProperty({ type: Object, example: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-31T23:59:59.999Z' } })
  period: { start: string; end: string };

  @ApiProperty({ type: [ApiUsageApiDto] })
  apis: ApiUsageApiDto[];
}

export class ApiRequestDto {
  @ApiProperty({ example: 'req_1' })
  @IsString()
  id: string;

  @ApiProperty({ example: 'otp', enum: ['otp', 'email', 'images', 'qr'] })
  @IsEnum(['otp', 'email', 'images', 'qr'])
  api: string;

  @ApiProperty({ example: 'POST', enum: ['GET', 'POST'] })
  @IsEnum(['GET', 'POST'])
  method: 'GET' | 'POST';

  @ApiProperty({ example: '/v1/otp/send' })
  @IsString()
  path: string;

  @ApiProperty({ example: 200 })
  @IsNumber()
  status: number;

  @ApiProperty({ example: 180 })
  @IsNumber()
  durationMs: number;

  @ApiProperty({ example: 'dpl_live_3fk2' })
  @IsString()
  keyPrefix: string;

  @ApiProperty({ example: 'live', enum: ['live', 'test'] })
  @IsEnum(['live', 'test'])
  mode: 'live' | 'test';

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  @IsString()
  at: string;
}

export class ApiRequestsDto {
  @ApiProperty({ type: [ApiRequestDto] })
  items: ApiRequestDto[];
}

export class TryRequestDto {
  @ApiProperty({ example: 'POST', enum: ['GET', 'POST'] })
  @IsEnum(['GET', 'POST'])
  method: 'GET' | 'POST';

  @ApiProperty({ example: '/v1/qr' })
  @IsString()
  path: string;

  @ApiPropertyOptional({ example: { data: 'hello' } })
  @IsOptional()
  body?: Record<string, unknown>;
}

export class TryResultDto {
  @ApiProperty({ example: 200 })
  @IsNumber()
  status: number;

  @ApiProperty({ example: 180 })
  @IsNumber()
  durationMs: number;

  @ApiProperty({ example: { id: 'qr_abc', url: 'blob:…' } })
  body: unknown;
}
