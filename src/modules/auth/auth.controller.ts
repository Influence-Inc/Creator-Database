import { Body, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { parseCookies } from '../../common/utils/cookies';
import { LoginDto } from './dto/login.dto';
import { AuthService, SESSION_COOKIE } from './auth.service';

/**
 * Admin-console auth. All three routes are @Public (reachable before a session
 * exists); the session cookie they manage is what unlocks the guarded read API.
 *
 *   POST /auth/login    { username, password } -> sets the session cookie
 *   POST /auth/logout   clears the session cookie
 *   GET  /auth/session  { authenticated, enforced }
 */
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private cookieOptions(maxAgeMs?: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.config.get<string>('server.nodeEnv') === 'production',
      path: '/',
      ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
    };
  }

  @Post('login')
  login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    if (!this.auth.isEnforced()) {
      // No admin password configured — auth is disabled, so "log in" is a no-op
      // success (the UI is open in this mode, same as the read API).
      return { authenticated: true, enforced: false };
    }
    if (!this.auth.validateCredentials(dto.username, dto.password)) {
      throw new UnauthorizedException('Invalid username or password');
    }
    const token = this.auth.issueToken(dto.username);
    res.cookie(SESSION_COOKIE, token, this.cookieOptions(this.auth.ttlSeconds() * 1000));
    return { authenticated: true, enforced: true };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
    return { authenticated: false };
  }

  @Get('session')
  session(@Req() req: Request) {
    const enforced = this.auth.isEnforced();
    if (!enforced) return { authenticated: true, enforced: false };
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return { authenticated: !!this.auth.verifyToken(token), enforced: true };
  }
}
