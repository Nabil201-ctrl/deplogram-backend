import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';

import { DatabaseService } from '../database/database.service.js';
import type { Viewer } from '../types.js';
import { SESSION_COOKIE } from './session.middleware.js';
import { SignInDto, SignUpDto, ViewerDto } from './dto.js';

/** How long a session cookie lasts (30 days). */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Authentication is owned by the backend. Sessions are signed JWTs stored in a
 * `deplogram_session` cookie and backed by server-side session rows in the
 * database, so they survive deploys and cold starts. Signing out revokes the
 * session row and clears the cookie.
 */
@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly db: DatabaseService) {}

  @Post('sign-in')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email and password', description: 'Creates a session cookie.' })
  @ApiBody({ type: SignInDto })
  @ApiResponse({ status: 200, description: 'Viewer returned + session cookie set', type: ViewerDto })
  @ApiResponse({ status: 400, description: 'Missing fields' })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  @ApiResponse({ status: 403, description: 'Sign-in is disabled' })
  async signIn(
    @Body() body: SignInDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Viewer> {
    if (process.env.SIGN_IN_ENABLED === 'false') {
      throw new UnauthorizedException('Sign-in is disabled');
    }
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) {
      throw new BadRequestException('Enter your email and password');
    }

    let viewer: Viewer;
    try {
      viewer = await this.db.signIn(email, password);
    } catch {
      throw new UnauthorizedException('Invalid email or password');
    }
    const sessionToken = await this.db.createSession(viewer.id, this.sessionInfo(req));
    res.setHeader('Set-Cookie', this.sessionCookie(sessionToken));
    return viewer;
  }

  /**
   * Creates an account and starts a session. The web sign-up form posts
   * `{ name, email, password }`. A new account gets an empty personal workspace
   * and returns no seeded demo records.
   */
  @Post('sign-up')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an account and start a session' })
  @ApiBody({ type: SignUpDto })
  @ApiResponse({ status: 201, description: 'Account created + session cookie set', type: ViewerDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async signUp(
    @Body() body: SignUpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Viewer> {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const email =
      typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!name) throw new BadRequestException('Enter your name');
    if (name.length > 64) {
      throw new BadRequestException('Keep your name under 64 characters');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Enter a valid email address');
    }
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }

    let viewer: Viewer;
    let sessionToken: string;
    try {
      const result = await this.db.signUp({ name, email, password });
      viewer = result.viewer;
      sessionToken = result.sessionToken;
    } catch (error) {
      if ((error as Error)?.message === 'Email already registered') {
        throw new ConflictException('That email is already registered');
      }
      throw error;
    }
    // Re-create the session with the request's client info (signUp used defaults).
    await this.db.endSession(sessionToken).catch(() => undefined);
    const freshToken = await this.db.createSession(viewer.id, this.sessionInfo(req));
    res.setHeader('Set-Cookie', this.sessionCookie(freshToken));
    return viewer;
  }

  @Post('sign-out')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out and clear the session cookie' })
  @ApiResponse({ status: 204, description: 'Session cleared' })
  async signOut(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = req.cookies?.[SESSION_COOKIE] ?? null;
    if (token) await this.db.endSession(token);
    res.setHeader('Set-Cookie', this.expiredSessionCookie());
  }

  private sessionInfo(req: Request): import('../database/database.js').SessionInfo {
    return {
      browser: req.headers['user-agent']?.split('/')[0] ?? 'unknown',
      os: 'unknown',
      device: /Mobile|Android|iPhone|iPad/.test(req.headers['user-agent'] ?? '') ? 'mobile' : 'desktop',
      location: null,
      ip: req.ip ?? '0.0.0.0',
    };
  }

  private sessionCookie(token: string): string {
    return this.cookie(token, SESSION_MAX_AGE_SECONDS);
  }

  private expiredSessionCookie(): string {
    return this.cookie('', 0);
  }

  /**
   * `SameSite=None; Secure` in production so the cookie also travels between
   * deplogram.app and the API's own origin; `Lax` locally, where there is no HTTPS.
   */
  private cookie(value: string, maxAge: number): string {
    const secure =
      process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
    const parts = [
      `${SESSION_COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      `Max-Age=${maxAge}`,
    ];
    if (secure) parts.push('Secure');
    parts.push(`SameSite=${secure ? 'None' : 'Lax'}`);
    return parts.join('; ');
  }
}
