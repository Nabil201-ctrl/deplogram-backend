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
  ApiCookieAuth,
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
import { requireUser } from '../auth/require-auth.js';

/**
 * Storage: one private drive per workspace, organised in folders. Files are
 * private; sharing is by expiring links — or a folder is made public and its
 * files get a permanent address.
 */
@ApiTags('storage')
@ApiCookieAuth('deplogram_session')
@Controller('v1/storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Get('list')
  @HttpCode(200)
  @ApiOperation({ summary: 'List the items inside one drive folder' })
  @ApiQuery({ name: 'path', type: String, required: false, example: 'assets/logos' })
  @ApiResponse({ status: 200, description: 'Folder contents', type: StorageListDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Folder not found' })
  async list(@Req() req: ExpressRequest, @Query('path') path: string) {
    const userId = requireUser(req).id;
    return this.storage.list(userId, path ?? '');
  }

  @Get('search')
  @HttpCode(200)
  @ApiOperation({ summary: 'Search the whole drive by file or folder name' })
  @ApiQuery({ name: 'q', type: String, required: true, example: 'logo' })
  @ApiResponse({ status: 200, description: 'Matching items', type: Object })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async search(@Req() req: ExpressRequest, @Query('q') q: string) {
    const userId = requireUser(req).id;
    return this.storage.search(userId, q ?? '');
  }

  @Get('folders')
  @HttpCode(200)
  @ApiOperation({ summary: 'Every folder path on the drive, for "Move to…"' })
  @ApiResponse({ status: 200, description: 'Folder paths', type: Object })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async folders(@Req() req: ExpressRequest) {
    const userId = requireUser(req).id;
    return this.storage.folders(userId);
  }

  @Post('folders')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create one folder' })
  @ApiBody({ type: CreateFolderDto })
  @ApiResponse({ status: 201, description: 'The new folder', type: StorageItemDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 409, description: 'Name already taken' })
  @ApiResponse({ status: 404, description: 'Parent folder not found' })
  async createFolder(@Req() req: ExpressRequest, @Body() body: CreateFolderDto) {
    const userId = requireUser(req).id;
    return this.storage.createFolder(userId, body.path);
  }

  @Post('uploads')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get a one-shot upload URL, then PUT the file there' })
  @ApiBody({ type: CreateUploadDto })
  @ApiResponse({ status: 200, description: 'Upload URL', type: UploadUrlDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 422, description: 'Not enough storage space' })
  async requestUpload(@Req() req: ExpressRequest, @Body() body: CreateUploadDto) {
    const userId = requireUser(req).id;
    return this.storage.requestUpload(userId, body.path, body.size, body.contentType);
  }

  @Put('uploads/:token')
  @HttpCode(201)
  @ApiOperation({ summary: 'PUT the file bytes to complete an upload' })
  @ApiParam({ name: 'token', type: String, example: 'upt_abc' })
  @ApiResponse({ status: 201, description: 'The stored file', type: StorageItemDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 410, description: 'Upload token expired' })
  async completeUpload(@Req() req: ExpressRequest, @Param('token') token: string) {
    const userId = requireUser(req).id;
    return this.storage.completeUpload(userId, token, req);
  }

  @Patch('items')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rename an item, or make a folder public/private' })
  @ApiBody({ type: PatchItemsDto })
  @ApiResponse({ status: 200, description: 'The updated item', type: StorageItemDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  @ApiResponse({ status: 409, description: 'Name already taken' })
  async patchItem(@Req() req: ExpressRequest, @Body() body: PatchItemsDto) {
    const userId = requireUser(req).id;
    return this.storage.patchItem(userId, body.path, body.name, body.public);
  }

  @Post('move')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move items into a folder' })
  @ApiBody({ type: MoveItemsDto })
  @ApiResponse({ status: 200, description: 'How many items moved', type: MovedDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 422, description: 'Bad move target' })
  async move(@Req() req: ExpressRequest, @Body() body: MoveItemsDto) {
    const userId = requireUser(req).id;
    return this.storage.move(userId, body.paths, body.to);
  }

  @Post('delete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete items; folders go with everything inside' })
  @ApiBody({ type: DeleteItemsDto })
  @ApiResponse({ status: 200, description: 'How many items deleted', type: DeletedDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  async remove(@Req() req: ExpressRequest, @Body() body: DeleteItemsDto) {
    const userId = requireUser(req).id;
    return this.storage.remove(userId, body.paths);
  }

  @Get('preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Preview a file: short-lived media URL or the text' })
  @ApiQuery({ name: 'path', type: String, required: true, example: 'docs/readme.md' })
  @ApiResponse({ status: 200, description: 'Preview data', type: StoragePreviewDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'File not found' })
  async preview(@Req() req: ExpressRequest, @Query('path') path: string) {
    const userId = requireUser(req).id;
    return this.storage.preview(userId, path ?? '');
  }

  @Post('links')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create an expiring link to a private file' })
  @ApiBody({ type: CreateLinkDto })
  @ApiResponse({ status: 200, description: 'Link and expiry', type: StorageLinkDto })
  @ApiResponse({ status: 401, description: 'No signed-in user' })
  @ApiResponse({ status: 404, description: 'File not found' })
  async createLink(@Req() req: ExpressRequest, @Body() body: CreateLinkDto) {
    const userId = requireUser(req).id;
    return this.storage.createLink(userId, body.path, body.expiresIn);
  }
}
