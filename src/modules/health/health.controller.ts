import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Health endpoints.
 *
 * `GET /health` is a pure **liveness** probe: it returns 200 the moment the
 * HTTP server is accepting requests, and never depends on the database. This
 * is what the platform healthcheck (Railway) hits — a deploy must go live as
 * soon as the process can serve HTTP, not gated on a DB round-trip that could
 * be slow while the connection pool warms up. The DB status is still reported
 * as an informational field, computed best-effort so it can never block, hang,
 * or throw.
 *
 * `GET /health/ready` is a **readiness** probe that does gate on the database,
 * for callers (or a stricter platform check) that want "is it fully ready to
 * serve traffic" rather than "is the process alive".
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Liveness — always 200 if the process can serve HTTP. */
  @Get()
  async check() {
    const database = await this.safeDbStatus();
    return {
      status: 'ok',
      database, // 'up' | 'down' — informational only, never gates liveness
      uptimeSeconds: Math.round(process.uptime()),
      environment: this.config.get<string>('server.nodeEnv'),
      railwayEnvironment: this.config.get<string>('server.railwayEnvironment') ?? null,
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness — reflects whether the database is reachable (200/reported). */
  @Get('ready')
  async ready() {
    const database = await this.safeDbStatus();
    return {
      status: database === 'up' ? 'ready' : 'not-ready',
      database,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Probe the DB without ever throwing or hanging the request: a failed or slow
   * connection resolves to 'down' within a short timeout instead of rejecting.
   */
  private async safeDbStatus(): Promise<'up' | 'down'> {
    try {
      const healthy = await Promise.race([
        this.prisma.isHealthy(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      return healthy ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
