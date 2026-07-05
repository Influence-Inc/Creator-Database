import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Health probe used by Railway's healthcheck. Returns 200 when the database is
 * reachable, and 503 when it isn't (so the platform can restart a wedged
 * instance). Kept dependency-light and fast.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async check() {
    const dbHealthy = await this.prisma.isHealthy();
    const payload = {
      status: dbHealthy ? 'ok' : 'error',
      database: dbHealthy ? 'up' : 'down',
      uptimeSeconds: Math.round(process.uptime()),
      environment: this.config.get<string>('server.nodeEnv'),
      railwayEnvironment: this.config.get<string>('server.railwayEnvironment') ?? null,
      timestamp: new Date().toISOString(),
    };

    if (!dbHealthy) {
      throw new ServiceUnavailableException(payload);
    }
    return payload;
  }
}
