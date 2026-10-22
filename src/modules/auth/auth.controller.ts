import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { UserRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { parseCookies } from '../../common/utils/cookies';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { isDeployed } from '../../common/utils/security';

/**
 * Admin-console auth. All three routes are @Public (reachable before a session
 * exists); the session cookie they manage is what unlocks the guarded read API.
 *
 *   POST /auth/login    { username, password } -> sets the session cookie
 *   POST /auth/logout   clears the session cookie
 *   GET  /auth/session  { authenticated, enforced }
 */
// Failed sign-ins allowed per client IP inside one window before /auth/login
// answers 429. Slows password guessing to a crawl without a dependency; the
// map lives in memory, which is fine for this single-instance service.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

function loginBlocked(ip: string, now = Date.now()): boolean {
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) return false;
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip: string, now = Date.now()): void {
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
  if (loginFailures.size > 10_000) {
    for (const [key, value] of loginFailures) if (value.resetAt <= now) loginFailures.delete(key);
  }
}

@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly users: UsersService,
  ) {}

  private cookieOptions(maxAgeMs?: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: isDeployed(),
      path: '/',
      ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
    };
  }

  /**
   * Sign in as either the env bootstrap admin or a database-backed account
   * (scouts, created by an admin in the console). The env admin is checked
   * first so an operator can always get in — even with an empty users table.
   */
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (loginBlocked(ip)) {
      throw new HttpException(
        'Too many failed sign-in attempts. Try again in 15 minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!this.auth.isEnforced()) {
      // No admin password configured — auth is disabled, so "log in" is a no-op
      // success (the UI is open in this mode, same as the read API).
      return { authenticated: true, enforced: false, role: UserRole.ADMIN };
    }

    if (this.auth.validateCredentials(dto.username, dto.password)) {
      loginFailures.delete(ip);
      this.setSession(res, this.auth.issueToken(dto.username, { role: UserRole.ADMIN }));
      return { authenticated: true, enforced: true, role: UserRole.ADMIN, username: dto.username };
    }

    const user = await this.users.validateLogin(dto.username, dto.password);
    if (!user) {
      recordLoginFailure(ip);
      // Same message for unknown user, wrong password and deactivated account —
      // don't leak which accounts exist.
      throw new UnauthorizedException('Invalid username or password');
    }

    loginFailures.delete(ip);
    this.setSession(res, this.auth.issueToken(user.username, { uid: user.id, role: user.role }));
    await this.users.recordLogin(user.id);
    return {
      authenticated: true,
      enforced: true,
      role: user.role,
      username: user.username,
      displayName: user.displayName,
    };
  }

  private setSession(res: Response, token: string): void {
    res.cookie(SESSION_COOKIE, token, this.cookieOptions(this.auth.ttlSeconds() * 1000));
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
    return { authenticated: false };
  }

  /**
   * Current session state. Includes the role so each front-end can decide what
   * to render (and so the scouting sheet can refuse to show an admin console).
   */
  @Get('session')
  session(@Req() req: Request) {
    const enforced = this.auth.isEnforced();
    if (!enforced) {
      return { authenticated: true, enforced: false, role: UserRole.ADMIN };
    }
    const principal = this.auth.verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!principal) return { authenticated: false, enforced: true };
    return {
      authenticated: true,
      enforced: true,
      role: principal.role,
      username: principal.username,
    };
  }
}
