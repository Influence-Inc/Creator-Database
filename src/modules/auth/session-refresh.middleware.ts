import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import { parseCookies } from '../../common/utils/cookies';
import { AuthService, SESSION_COOKIE } from './auth.service';

/**
 * Sliding-window session refresh. When a request arrives with a valid session
 * cookie and it's already past the halfway mark of its TTL, mint a fresh token
 * and re-set the cookie so an active admin's session never dies mid-use.
 *
 * Without this the cookie's Max-Age is fixed at issue time — a user who logged
 * in at 9am gets kicked out at 9pm even if they've been clicking around all
 * day, which is what "keeps getting logged out" felt like.
 *
 * Only refreshes when >50% of the TTL has elapsed so we're not stamping a
 * Set-Cookie header onto every request. Invalid cookies are left alone (the
 * guards do their normal thing).
 */
@Injectable()
export class SessionRefreshMiddleware implements NestMiddleware {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.auth.isEnforced()) return next();
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const subject = this.auth.verifyToken(token);
    if (!subject) return next();

    const remaining = this.auth.remainingMs(token);
    const ttlMs = this.auth.ttlSeconds() * 1000;
    // Only refresh past the halfway mark — a busy user with a fresh cookie
    // doesn't need a Set-Cookie on every roster fetch.
    if (remaining !== null && remaining > ttlMs / 2) return next();

    const fresh = this.auth.issueToken(subject);
    res.cookie(SESSION_COOKIE, fresh, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get<string>('server.nodeEnv') === 'production',
      path: '/',
      maxAge: ttlMs,
    });
    next();
  }
}
