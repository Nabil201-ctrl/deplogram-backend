import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class StorageItemDto {
  @ApiProperty({ example: 'folder', enum: ['folder', 'file'] })
  @IsString()
  kind: 'folder' | 'file';

  @ApiProperty({ example: 'logo.svg' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'assets/logos/logo.svg' })
  @IsString()
  path: string;

  @ApiProperty({ example: 4096 })
  @IsNumber()
  size: number;

  @ApiPropertyOptional({ example: 'image/svg+xml' })
  @IsOptional()
  @IsString()
  contentType: string | null;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsNumber()
  items: number | null;

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  @IsString()
  createdAt: string;

  @ApiProperty({ example: '2026-10-20T03:11:53.675Z' })
  @IsString()
  updatedAt: string;

  @ApiPropertyOptional({ example: null })
  @IsOptional()
  @IsString()
  thumbnailUrl: string | null;

  @ApiProperty({ example: false })
  @IsBoolean()
  public: boolean;

  @ApiPropertyOptional({ example: null })
  @IsOptional()
  @IsString()
  publicUrl: string | null;
}

export class StorageListDto {
  @ApiProperty({ example: 'assets/logos' })
  @IsString()
  path: string;

  @ApiProperty({ type: [StorageItemDto] })
  items: StorageItemDto[];

  @ApiProperty({ example: false })
  @IsBoolean()
  public: boolean;

  @ApiPropertyOptional({ example: null })
  @IsOptional()
  @IsString()
  publicFrom: string | null;
}

export class StorageLinkDto {
  @ApiProperty({ example: 'https://files.dpl.app/ada/assets/logos/logo.svg?token=abc' })
  @IsString()
  url: string;

  @ApiProperty({ example: '2026-10-20T04:11:53.680Z' })
  @IsString()
  expiresAt: string;
}

export class CreateFolderDto {
  @ApiProperty({ example: 'uploads/invoices' })
  @IsString()
  @IsNotEmpty()
  path: string;
}

export class CreateUploadDto {
  @ApiProperty({ example: 'uploads/avatars/user-1.jpg' })
  @IsString()
  path: string;

  @ApiProperty({ example: 48211 })
  @IsNumber()
  size: number;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  contentType: string;
}

export class UploadUrlDto {
  @ApiProperty({ example: '/v1/storage/uploads/upt_abc' })
  @IsString()
  uploadUrl: string;
}

export class PatchItemsDto {
  @ApiProperty({ example: 'uploads/avatars/user-1.jpg' })
  @IsString()
  path: string;

  @ApiPropertyOptional({ example: 'user-1 (1).jpg' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  public?: boolean;
}

export class MoveItemsDto {
  @ApiProperty({ type: [String], example: ['uploads/avatars/user-1.jpg'] })
  @IsString()
  paths: string[];

  @ApiProperty({ example: 'uploads/avatars' })
  @IsString()
  to: string;
}

export class DeleteItemsDto {
  @ApiProperty({ type: [String], example: ['uploads/avatars/user-1.jpg'] })
  @IsString()
  paths: string[];
}

export class MovedDto {
  @ApiProperty({ example: 3 })
  @IsNumber()
  moved: number;
}

export class DeletedDto {
  @ApiProperty({ example: 2 })
  @IsNumber()
  deleted: number;
}

export class StoragePreviewDto {
  @ApiPropertyOptional({ example: null })
  @IsOptional()
  @IsString()
  url: string | null;

  @ApiPropertyOptional({ example: '# Hello\n' })
  @IsOptional()
  @IsString()
  text: string | null;

  @ApiProperty({ example: false })
  @IsBoolean()
  truncated: boolean;
}

export class CreateLinkDto {
  @ApiProperty({ example: 'uploads/invoices/INV-2026-0912.pdf' })
  @IsString()
  path: string;

  @ApiProperty({ example: '1d', enum: ['1h', '1d', '7d'] })
  @IsEnum(['1h', '1d', '7d'])
  expiresIn: '1h' | '1d' | '7d';
}
