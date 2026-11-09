import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';

import { StorageService } from './storage.service.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import {
  StorageItemDto,
  StorageListDto,
  StorageLinkDto,
  CreateFolderDto,
  CreateUploadDto,
  UploadUrlDto,
  PatchItemsDto,
  MoveItemsDto,
  DeleteItemsDto,
  MovedDto,
  DeletedDto,
  StoragePreviewDto,
  CreateLinkDto,
} from './dto.js';

/**
 * Storage: one private drive per workspace, organised in folders. Files are private;
 * sharing is by expiring links — or a folder is made public and its files get a
 * permanent address.
 */
@ApiTags('storage')
@Controller('v1/storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Get('list')
  @HttpCode(200)
  @ApiOperation({ summary: 'List the items inside one drive folder' })
  @ApiQuery({ name: 'path', type: String, required: false, example: 'assets/logos' })
  @ApiResponse({ status: 200, description: 'Folder contents', type: StorageListDto })
  @ApiResponse({ status: 404, description: 'Folder not found' })
  list(@Query('path') path: string) {
    return this.storage.list(path ?? '');
  }

  @Get('search')
  @HttpCode(200)
  @ApiOperation({ summary: 'Search the whole drive by file or folder name' })
  @ApiQuery({ name: 'q', type: String, required: true, example: 'logo' })
  @ApiResponse({ status: 200, description: 'Matching items', type: Object })
  search(@Query('q') q: string) {
    return this.storage.search(q ?? '');
  }

  @Get('folders')
  @HttpCode(200)
  @ApiOperation({ summary: 'Every folder path on the drive, for "Move to…"' })
  @ApiResponse({ status: 200, description: 'Folder paths', type: Object })
  folders() {
    return this.storage.folders();
  }

  @Post('folders')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create one folder' })
  @ApiBody({ type: CreateFolderDto })
  @ApiResponse({ status: 201, description: 'The new folder', type: StorageItemDto })
  @ApiResponse({ status: 409, description: 'Name already taken' })
  @ApiResponse({ status: 404, description: 'Parent folder not found' })
  createFolder(@Body() body: CreateFolderDto) {
    return this.storage.createFolder(body.path);
  }

  @Post('uploads')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get a one-shot upload URL, then PUT the file there' })
  @ApiBody({ type: CreateUploadDto })
  @ApiResponse({ status: 200, description: 'Upload URL', type: UploadUrlDto })
  @ApiResponse({ status: 422, description: 'Not enough storage space' })
  requestUpload(@Body() body: CreateUploadDto) {
    return this.storage.requestUpload(body.path, body.size, body.contentType);
  }

  @Put('uploads/:token')
  @HttpCode(201)
  @ApiOperation({ summary: 'PUT the file bytes to complete an upload' })
  @ApiParam({ name: 'token', type: String, example: 'upt_abc' })
  @ApiResponse({ status: 201, description: 'The stored file', type: StorageItemDto })
  @ApiResponse({ status: 410, description: 'Upload token expired' })
  completeUpload(@Param('token') token: string, @Req() req: ExpressRequest) {
    return this.storage.completeUpload(token, req);
  }

  @Patch('items')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rename an item, or make a folder public/private' })
  @ApiBody({ type: PatchItemsDto })
  @ApiResponse({ status: 200, description: 'The updated item', type: StorageItemDto })
  @ApiResponse({ status: 404, description: 'Item not found' })
  @ApiResponse({ status: 409, description: 'Name already taken' })
  patchItem(@Body() body: PatchItemsDto) {
    return this.storage.patchItem(body.path, body.name, body.public);
  }

  @Post('move')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move items into a folder' })
  @ApiBody({ type: MoveItemsDto })
  @ApiResponse({ status: 200, description: 'How many items moved', type: MovedDto })
  @ApiResponse({ status: 422, description: 'Bad move target' })
  move(@Body() body: MoveItemsDto) {
    return this.storage.move(body.paths, body.to);
  }

  @Post('delete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete items; folders go with everything inside' })
  @ApiBody({ type: DeleteItemsDto })
  @ApiResponse({ status: 200, description: 'How many items deleted', type: DeletedDto })
  remove(@Body() body: DeleteItemsDto) {
    return this.storage.remove(body.paths);
  }

  @Get('preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Preview a file: short-lived media URL or the text' })
  @ApiQuery({ name: 'path', type: String, required: true, example: 'docs/readme.md' })
  @ApiResponse({ status: 200, description: 'Preview data', type: StoragePreviewDto })
  @ApiResponse({ status: 404, description: 'File not found' })
  preview(@Query('path') path: string) {
    return this.storage.preview(path ?? '');
  }

  @Post('links')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create an expiring link to a private file' })
  @ApiBody({ type: CreateLinkDto })
  @ApiResponse({ status: 200, description: 'Link and expiry', type: StorageLinkDto })
  @ApiResponse({ status: 404, description: 'File not found' })
  createLink(@Body() body: CreateLinkDto) {
    return this.storage.createLink(body.path, body.expiresIn);
  }
}
