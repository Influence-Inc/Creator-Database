import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { parseCookies } from '../utils/cookies';
import { AuthService, SESSION_COOKIE } from '../../modules/auth/auth.service';

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Global guard that closes the read API. A read request is allowed when it
 * carries EITHER a valid admin session cookie (the browser console) OR the
 * `x-api-key` shared secret (machine consumers). Mutations are left to
 * ApiKeyGuard; OPTIONS (CORS preflight) and @Public routes pass through.
 *
 * Enforcement only kicks in once ADMIN_PASSWORD is configured — so dev/test and
 * existing deploys that haven't set it keep their current open-read behaviour,
 * exactly like ApiKeyGuard does for writes.
 */
@Injectable()
export class ReadAccessGuard implements CanActivate {
  private readonly logger = new Logger(ReadAccessGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const method = String(req.method || '').toUpperCase();
    if (!READ_METHODS.has(method)) return true; // writes handled by ApiKeyGuard

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Not enforced until an admin password is set — preserves open reads for
    // dev/test and un-migrated deployments (with a heads-up in the logs).
    if (!this.auth.isEnforced()) {
      this.logger.warn('ADMIN_PASSWORD is not set — read endpoints are UNAUTHENTICATED');
      return true;
    }

    // 1) Valid admin session cookie (browser console).
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (this.auth.verifyToken(token)) return true;

    // 2) Machine consumers presenting the shared secret.
    const expectedKey = this.config.get<string>('security.internalApiKey');
    const provided = req.headers['x-api-key'];
    const key = Array.isArray(provided) ? provided[0] : provided;
    if (expectedKey && key && key === expectedKey) return true;

    throw new UnauthorizedException('Authentication required');
  }
}
