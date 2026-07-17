import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'cdb_session';

/**
 * Minimal, dependency-free session auth for the admin console.
 *
 * - Credentials come from ADMIN_USERNAME / ADMIN_PASSWORD (env).
 * - On login we mint a compact HMAC-signed token (`<base64url(payload)>.<sig>`)
 *   carrying the subject + expiry, and set it as an httpOnly cookie.
 * - Every guarded request re-verifies the signature and expiry — no server-side
 *   session store, so it scales across replicas as long as they share the
 *   signing secret (AUTH_SESSION_SECRET, else INTERNAL_API_KEY).
 */
@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private secret = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const configured =
      this.config.get<string>('auth.sessionSecret') ||
      this.config.get<string>('security.internalApiKey') ||
      '';
    if (configured) {
      this.secret = configured;
    } else {
      // No stable secret configured — generate an ephemeral one so tokens are
      // still unforgeable, but warn that sessions reset on restart / per replica.
      this.secret = randomBytes(32).toString('hex');
      if (this.isEnforced()) {
        this.logger.warn(
          'No AUTH_SESSION_SECRET / INTERNAL_API_KEY set — using an ephemeral signing secret; sessions will not survive restarts or span multiple instances.',
        );
      }
    }
  }

  /** True once an admin password is configured (auth is then enforced). */
  isEnforced(): boolean {
    return !!this.config.get<string>('auth.adminPassword');
  }

  private ttlMs(): number {
    return (this.config.get<number>('auth.sessionTtlHours') ?? 12) * 3600 * 1000;
  }

  ttlSeconds(): number {
    return Math.floor(this.ttlMs() / 1000);
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  /** Validate a username/password against the configured admin credentials. */
  validateCredentials(username: string, password: string): boolean {
    const expectedUser = this.config.get<string>('auth.adminUsername') ?? 'admin';
    const expectedPass = this.config.get<string>('auth.adminPassword') ?? '';
    if (!expectedPass) return false;
    // Compare both fields in constant time (avoids leaking which one differed).
    const userOk = this.safeEqual(username || '', expectedUser);
    const passOk = this.safeEqual(password || '', expectedPass);
    return userOk && passOk;
  }

  private sign(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }

  /** Issue a signed session token for the admin subject. */
  issueToken(subject = 'admin'): string {
    const payload = { sub: subject, exp: Date.now() + this.ttlMs() };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /** Verify a session token's signature + expiry. Returns the subject or null. */
  verifyToken(token: string | undefined | null): string | null {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!this.safeEqual(sig, this.sign(body))) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
