import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class PadFileDto {
  @ApiProperty({ example: 'index.html' })
  @IsString()
  path: string;

  @ApiProperty({ example: '<h1>Hello</h1>\n' })
  @IsString()
  content: string;

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  @IsString()
  updatedAt: string;
}

export class PadSummaryDto {
  @ApiProperty({ example: 'pad_1' })
  @IsString()
  id: string;

  @ApiProperty({ example: 'landing-page' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'static' })
  @IsString()
  runtime: string;

  @ApiProperty({ example: 3 })
  @IsNumber()
  fileCount: number;

  @ApiProperty({ type: [String], example: ['index.html', 'style.css', 'script.js'] })
  @IsString()
  paths: string[];

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  @IsString()
  updatedAt: string;

  @ApiPropertyOptional({ example: 'proj_abc' })
  @IsOptional()
  @IsString()
  projectId: string | null;
}

export class PadDto extends PadSummaryDto {
  @ApiProperty({ example: 'index.html' })
  @IsString()
  entry: string;

  @ApiProperty({ type: [PadFileDto] })
  files: PadFileDto[];
}

export class RunLogLineDto {
  @ApiProperty({ example: 1 })
  @IsNumber()
  n: number;

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  @IsString()
  at: string;

  @ApiProperty({ example: '$ node index.js' })
  @IsString()
  text: string;

  @ApiProperty({ example: 'stdout', enum: ['stdout', 'stderr'] })
  @IsString()
  stream: 'stdout' | 'stderr';
}

export class RunLogsDto {
  @ApiProperty({ type: [RunLogLineDto] })
  lines: RunLogLineDto[];

  @ApiProperty({ example: true })
  done: boolean;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  exitCode: number | null;
}

export class CreatePadDto {
  @ApiProperty({ example: 'my-pad' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'node', enum: ['static', 'node', 'python'] })
  @IsEnum(['static', 'node', 'python'])
  template: 'static' | 'node' | 'python';
}

export class UpdatePadDto {
  @ApiProperty({ example: 'renamed-pad' })
  @IsString()
  @IsNotEmpty()
  name: string;
}

export class SavePadFileDto {
  @ApiProperty({ example: 'index.html' })
  @IsString()
  path: string;

  @ApiProperty({ example: '<h1>Hi</h1>\n' })
  @IsString()
  content: string;
}

export class RenamePadFileDto {
  @ApiProperty({ example: 'index.html' })
  @IsString()
  from: string;

  @ApiProperty({ example: 'home.html' })
  @IsString()
  to: string;
}

export class StartRunDto {
  @ApiProperty({ example: 'run_abc' })
  @IsString()
  id: string;
}
