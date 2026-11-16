import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import type { Viewer } from '../types.js';
import { AuthenticatedRequest } from './session.middleware.js';

/** Returns the authenticated viewer for the current request, or throws 401. */
export function requireUser(req: Request): Viewer {
  const user = (req as AuthenticatedRequest).user;
  if (!user) throw new UnauthorizedException('No signed-in user');
  return user;
}

/** Returns the authenticated user id for the current request, or throws 401. */
export function requireUserId(req: Request): string {
  return requireUser(req).id;
}
