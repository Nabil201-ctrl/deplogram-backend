import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import { DeplogramStore } from '../store.js';
import type { WebhookSample } from '../types.js';

@Injectable()
export class WebhooksService {
  constructor(private readonly store: DeplogramStore) {}

  endpoint() {
    const endpoint = this.store.getWebhookEndpoint();
    if (!endpoint) throw new NotFoundException('No webhook endpoint yet.');
    return endpoint;
  }

  rotate() {
    return this.store.rotateWebhookEndpoint();
  }

  list() {
    return { items: this.store.listWebhookRequests() };
  }

  clear() {
    this.store.clearWebhookRequests();
  }

  test(sample: WebhookSample) {
    const request = this.store.captureWebhookRequest({
      method: 'POST',
      path: sample === 'form' ? '/signup' : '/',
      query: sample === 'form' ? [['ref', 'newsletter']] : [],
      headers: sample === 'form' ? [['content-type', 'application/x-www-form-urlencoded']] : [['content-type', 'application/json']],
      body: sample === 'form' ? 'name=Funke+Adebayo&email=funke@example.com&plan=plus' : JSON.stringify({ event: 'sample', source: sample }),
      contentType: sample === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
      size: Buffer.byteLength(sample === 'form' ? 'name=Funke+Adebayo&email=funke@example.com&plan=plus' : JSON.stringify({ event: 'sample', source: sample })),
      ip: '102.89.1.2',
    });
    return request;
  }

  replay(id: string, url: string) {
    const request = this.store.getWebhookRequest(id);
    if (!request) throw new NotFoundException('That request is gone.');
    if (!/^https?:\/\//.test(url)) {
      throw new UnprocessableEntityException('Use a full address starting with https://');
    }
    if (/localhost|127\.0\.0\.1/.test(url)) {
      throw new UnprocessableEntityException("Deplogram can't reach localhost — use a public address or a tunnel.");
    }
    return { status: 200, durationMs: 180 + Math.floor(Math.random() * 300), error: null };
  }
}
