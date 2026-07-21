import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { parseCookies } from '../utils/cookies';
import { AuthService, SESSION_COOKIE } from '../../modules/auth/auth.service';

/**
 * Route guard for admin-console writes (e.g. editing a creator's contact/payout
 * details from the dashboard). Allows the request when it carries EITHER a valid
 * admin session cookie OR the `x-api-key` shared secret. Enforcement only kicks
 * in once ADMIN_PASSWORD is configured — same convention as the read guard — so
 * dev/test stays open.
 *
 * Apply with `@UseGuards(AdminWriteGuard)` on a route also marked `@Public()`
 * (so the global ApiKeyGuard doesn't demand x-api-key first).
 */
@Injectable()
export class AdminWriteGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.auth.isEnforced()) return true;

    const req = context.switchToHttp().getRequest<Request>();

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (this.auth.verifyToken(token)) return true;

    const expectedKey = this.config.get<string>('security.internalApiKey');
    const provided = req.headers['x-api-key'];
    const key = Array.isArray(provided) ? provided[0] : provided;
    if (expectedKey && key && key === expectedKey) return true;

    throw new UnauthorizedException('Authentication required');
  }
}
