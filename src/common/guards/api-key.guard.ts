import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { apiKeyHeader, isDeployed, secretEquals } from '../utils/security';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard that protects the write surface with a shared secret. Mutating
 * requests (POST/PATCH/PUT/DELETE) must send `x-api-key: INTERNAL_API_KEY`;
 * safe/read methods and the health check pass through untouched, so existing
 * read consumers keep working. When INTERNAL_API_KEY isn't configured (test/dev),
 * writes stay open with a warning — env.validation requires it outside tests, so
 * production always enforces.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(String(req.method || '').toUpperCase())) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const expected = this.config.get<string>('security.internalApiKey');
    if (!expected) {
      if (isDeployed()) {
        this.logger.error('INTERNAL_API_KEY is not set — write endpoints are LOCKED until it is');
        throw new UnauthorizedException('Write API is not configured on this server');
      }
      this.logger.warn(
        'INTERNAL_API_KEY is not set — write endpoints are UNAUTHENTICATED (local only)',
      );
      return true;
    }

    if (secretEquals(apiKeyHeader(req.headers), expected)) return true;

    throw new UnauthorizedException('Invalid or missing x-api-key');
  }
}
