import { Injectable, NotFoundException } from '@nestjs/common';

import { DeplogramStore } from '../store.js';
import type { ApiId, TryRequest } from '../types.js';

@Injectable()
export class ApisService {
  constructor(private readonly store: DeplogramStore) {}

  usage() {
    return this.store.getApiUsage();
  }

  requests(api?: ApiId) {
    return { items: this.store.listApiRequests(api) };
  }

  try(request: TryRequest) {
    return this.store.tryApi(request);
  }

  keys() {
    return { items: this.store.listApiKeys() };
  }

  createKey(name: string, mode: 'live' | 'test', access: string[]) {
    const validAccess = access.filter((a) => ['otp', 'email', 'images', 'qr'].includes(a)) as ApiId[];
    return this.store.createApiKey({ name, mode, access: validAccess });
  }

  revokeKey(id: string) {
    const revoked = this.store.revokeApiKey(id);
    if (!revoked) throw new NotFoundException('That key does not exist.');
  }
}
