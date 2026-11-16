import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

import { DatabaseService } from '../database/database.service.js';
import type { Viewer } from '../types.js';

const SESSION_COOKIE = 'deplogram_session';

export interface AuthenticatedRequest extends Request {
  user?: Viewer;
  userId?: string;
}

/**
 * Restores the signed-in user for every request from the `deplogram_session`
 * cookie. The cookie holds a signed JWT; the session row is checked for
 * revocation, so signing out ends the session everywhere. The resolved user is
 * attached to the request (`req.user`, `req.userId`) — there is no shared
 * singleton current user, so every request resolves its own authenticated user.
 * Sessions survive cold starts because the JWT is verified statelessly and the
 * underlying users/sessions live in the persistent database.
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(private readonly db: DatabaseService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    (req as AuthenticatedRequest).user = undefined;
    (req as AuthenticatedRequest).userId = undefined;
    const token = req.cookies?.[SESSION_COOKIE] ?? null;
    if (!token) return next();
    Promise.resolve()
      .then(() => this.db.getSession(token))
      .then((session) => {
        if (!session) return;
        (req as AuthenticatedRequest).userId = session.userId;
        return this.db.getUser(session.userId);
      })
      .then((user) => {
        if (user) {
          (req as AuthenticatedRequest).user = {
            id: user.id,
            name: user.name,
            email: user.email,
            image: user.image,
          };
        }
      })
      .catch(() => {
        // A malformed or revoked session simply means no authenticated user.
      })
      .finally(() => {
        if (token) void this.db.touchSession(token);
        next();
      });
  }
}

export { SESSION_COOKIE };
