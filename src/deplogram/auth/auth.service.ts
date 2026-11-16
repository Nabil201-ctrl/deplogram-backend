import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import type { Viewer } from '../types.js';

/**
 * Authentication helpers backed by the database. The authenticated viewer is
 * resolved per request from the session cookie (see SessionMiddleware) and
 * attached to the request; there is no shared singleton current user.
 */
@Injectable()
export class AuthService {
  constructor(private readonly db: DatabaseService) {}

  async signIn(email: string, password: string): Promise<Viewer> {
    return this.db.signIn(email, password);
  }

  async signOut(sessionToken: string | null): Promise<void> {
    if (sessionToken) await this.db.endSession(sessionToken);
  }
}
