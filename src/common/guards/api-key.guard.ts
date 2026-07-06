import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

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

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(String(req.method || '').toUpperCase())) return true;

    const expected = this.config.get<string>('security.internalApiKey');
    if (!expected) {
      this.logger.warn('INTERNAL_API_KEY is not set — write endpoints are UNAUTHENTICATED');
      return true;
    }

    const provided = req.headers['x-api-key'];
    const key = Array.isArray(provided) ? provided[0] : provided;
    if (key && key === expected) return true;

    throw new UnauthorizedException('Invalid or missing x-api-key');
  }
}
