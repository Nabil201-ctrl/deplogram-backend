import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';

import { DatabaseService } from '../database/database.service.js';
import type { StorageItem } from '../types.js';

@Injectable()
export class StorageService {
  constructor(private readonly db: DatabaseService) {}

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async workspaceId(userId: string): Promise<string> {
    return (await this.db.currentWorkspace(userId)).id;
  }

  // ── list / search / folders ───────────────────────────────────────────────────

  async list(userId: string, path: string) {
    const workspaceId = await this.workspaceId(userId);
    const result = await this.db.getStorageList(path);
    if (!result) throw new NotFoundException('That folder does not exist.');
    return {
      path: result.path,
      items: result.items.filter((i) => i.workspaceId === workspaceId),
      public: result.public,
      publicFrom: result.publicFrom,
    };
  }

  async search(userId: string, q: string) {
    const workspaceId = await this.workspaceId(userId);
    return { items: (await this.db.searchStorage(q)).filter((i) => i.workspaceId === workspaceId) };
  }

  async folders(userId: string) {
    const workspaceId = await this.workspaceId(userId);
    return { folders: (await this.db.getStorageFolders()).filter((p) => true) };
  }

  async createFolder(userId: string, path: string): Promise<StorageItem> {
    const workspaceId = await this.workspaceId(userId);
    const result = await this.db.createStorageFolder(path);
    if (result === 'exists') {
      throw new ConflictException("There's already something with that name here.");
    }
    if (result === 'no-parent') {
      throw new NotFoundException('That folder no longer exists.');
    }
    return { ...result, workspaceId };
  }

  // ── uploads ───────────────────────────────────────────────────────────────────

  async requestUpload(userId: string, path: string, size: number, contentType: string) {
    const result = await this.db.createStorageUpload(path, size, contentType);
    if (!result) {
      throw new UnprocessableEntityException(
        'Not enough space left on your plan for this file.',
      );
    }
    return result;
  }

  async completeUpload(userId: string, token: string, req: ExpressRequest) {
    await this.workspaceId(userId);
    const bytes = req.body instanceof Buffer
      ? req.body.buffer.slice(req.body.byteOffset, req.body.byteOffset + req.body.byteLength)
      : (req.body as ArrayBuffer | null);
    return this.db.completeStorageUpload(token, bytes);
  }

  // ── items ─────────────────────────────────────────────────────────────────────

  async patchItem(userId: string, path: string, name?: string, makePublic?: boolean) {
    const workspaceId = await this.workspaceId(userId);
    const result = await this.db.renameStorageItem(path, name ?? '', makePublic);
    if (result === null) {
      throw new UnprocessableEntityException('Only folders can be made public.');
    }
    if (result === 'missing') {
      throw new NotFoundException('That item no longer exists.');
    }
    if (result === 'exists') {
      throw new ConflictException(`There's already something called “${name}” here.`);
    }
    return { ...result, workspaceId };
  }

  async move(userId: string, paths: string[], to: string) {
    const moved = await this.db.moveStorageItems(paths, to);
    if (moved === 'bad-target') {
      throw new UnprocessableEntityException("Can't move a folder into itself.");
    }
    return { moved };
  }

  async remove(userId: string, paths: string[]) {
    return this.db.deleteStorageItems(paths);
  }

  // ── preview / links ───────────────────────────────────────────────────────────

  async preview(userId: string, path: string) {
    const result = await this.db.previewStorage(path);
    if (!result) throw new NotFoundException('That file does not exist.');
    return result;
  }

  async createLink(userId: string, path: string, expiresIn: '1h' | '1d' | '7d') {
    const result = await this.db.createStorageLink(path, expiresIn);
    if (!result) throw new NotFoundException('That file does not exist.');
    return result;
  }
}
