import {
  ConflictException,
  Injectable,
  NotFoundException,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';

import { DeplogramStore } from '../store.js';
import type { StorageItem } from '../types.js';

@Injectable()
export class StorageService {
  constructor(private readonly store: DeplogramStore) {}

  // ── list / search / folders ───────────────────────────────────────────────────

  list(path: string) {
    const result = this.store.getStorageList(path);
    if (!result) throw new NotFoundException('That folder does not exist.');
    return result;
  }

  search(q: string) {
    return { items: this.store.searchStorage(q) };
  }

  folders() {
    return { folders: this.store.getStorageFolders() };
  }

  createFolder(path: string): StorageItem {
    const result = this.store.createStorageFolder(path);
    if (result === 'exists') {
      throw new ConflictException("There's already something with that name here.");
    }
    if (result === 'no-parent') {
      throw new NotFoundException('That folder no longer exists.');
    }
    return result;
  }

  // ── uploads ───────────────────────────────────────────────────────────────────

  requestUpload(path: string, size: number, contentType: string) {
    const result = this.store.createStorageUpload(path, size, contentType);
    if (!result) {
      throw new UnprocessableEntityException(
        'Not enough space left on your plan for this file.',
      );
    }
    return result;
  }

  completeUpload(token: string, @Req() req: ExpressRequest) {
    const bytes = req.body instanceof Buffer ? req.body.buffer.slice(req.body.byteOffset, req.body.byteOffset + req.body.byteLength) : (req.body as ArrayBuffer | null);
    return this.store.completeStorageUpload(token, bytes);
  }

  // ── items ─────────────────────────────────────────────────────────────────────

  patchItem(path: string, name?: string, makePublic?: boolean) {
    const result = this.store.renameStorageItem(path, name ?? '', makePublic);
    if (result === null) {
      throw new UnprocessableEntityException('Only folders can be made public.');
    }
    if (result === 'missing') {
      throw new NotFoundException('That item no longer exists.');
    }
    if (result === 'exists') {
      throw new ConflictException(`There's already something called “${name}” here.`);
    }
    return result;
  }

  move(paths: string[], to: string) {
    const moved = this.store.moveStorageItems(paths, to);
    if (moved === 'bad-target') {
      throw new UnprocessableEntityException("Can't move a folder into itself.");
    }
    return { moved };
  }

  remove(paths: string[]) {
    return this.store.deleteStorageItems(paths);
  }

  // ── preview / links ───────────────────────────────────────────────────────────

  preview(path: string) {
    const result = this.store.previewStorage(path);
    if (!result) throw new NotFoundException('That file does not exist.');
    return result;
  }

  createLink(path: string, expiresIn: '1h' | '1d' | '7d') {
    const result = this.store.createStorageLink(path, expiresIn);
    if (!result) throw new NotFoundException('That file does not exist.');
    return result;
  }
}
