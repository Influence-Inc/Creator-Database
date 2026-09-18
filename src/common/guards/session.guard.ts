import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { parseCookies } from '../utils/cookies';
import { AuthPrincipal, AuthService, SESSION_COOKIE } from '../../modules/auth/auth.service';

/** Request augmented with the verified principal, set by this guard. */
export interface AuthedRequest extends Request {
  principal?: AuthPrincipal;
}

/**
 * Role-aware guard for session-backed routes (the scouting sheet, scouter
 * account management). Apply with `@UseGuards(SessionGuard)` alongside
 * `@Public()` so the global ApiKeyGuard/ReadAccessGuard step aside and this
 * guard becomes the single authority for the route.
 *
 * Allows a request when it carries EITHER a valid session cookie whose role is
 * permitted, OR the `x-api-key` shared secret (treated as ADMIN, for machine
 * consumers). The verified principal is attached to `req.principal` so
 * controllers can scope queries to the signed-in scout.
 *
 * Enforcement follows the same convention as the other guards: when no
 * ADMIN_PASSWORD is configured, auth isn't enforced and requests pass through
 * as the bootstrap admin so dev/test stays open.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (String(req.method || '').toUpperCase() === 'OPTIONS') return true;

    const allowed = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [UserRole.ADMIN];

    // Auth disabled (dev/test): behave as the bootstrap admin.
    if (!this.auth.isEnforced()) {
      req.principal = { username: 'admin', uid: null, role: UserRole.ADMIN };
      return true;
    }

    // Machine consumers with the shared secret act as ADMIN.
    const expectedKey = this.config.get<string>('security.internalApiKey');
    const provided = req.headers['x-api-key'];
    const key = Array.isArray(provided) ? provided[0] : provided;
    if (expectedKey && key && key === expectedKey) {
      req.principal = { username: 'api-key', uid: null, role: UserRole.ADMIN };
      return this.assertRole(UserRole.ADMIN, allowed);
    }

    const principal = this.auth.verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!principal) throw new UnauthorizedException('Authentication required');

    req.principal = principal;
    return this.assertRole(principal.role, allowed);
  }

  private assertRole(role: UserRole, allowed: UserRole[]): boolean {
    if (allowed.includes(role)) return true;
    throw new ForbiddenException('You do not have access to this resource');
  }
}
