import { Injectable, NotFoundException } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import type { ApiId, TryRequest } from '../types.js';

@Injectable()
export class ApisService {
  constructor(private readonly store: DatabaseService) {}

  async usage() {
    return this.store.getApiUsage();
  }

  async requests(api?: ApiId) {
    return { items: await this.store.listApiRequests(api) };
  }

  async try(request: TryRequest) {
    return this.store.tryApi(request);
  }

  async keys(userId: string) {
    return { items: await this.store.listApiKeys(userId) };
  }

  async createKey(userId: string, name: string, mode: 'live' | 'test', access: string[]) {
    const validAccess = access.filter((a) => ['otp', 'email', 'images', 'qr'].includes(a)) as ApiId[];
    return this.store.createApiKey(userId, { name, mode, access: validAccess });
  }

  async revokeKey(userId: string, id: string) {
    const revoked = await this.store.revokeApiKey(id);
    if (!revoked) throw new NotFoundException('That key does not exist.');
  }
}
