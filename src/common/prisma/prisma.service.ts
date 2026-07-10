import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin wrapper around PrismaClient that ties the connection lifecycle to the
 * Nest module lifecycle and exposes a health probe. Inject this everywhere a
 * repository needs database access.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      // Surface warnings/errors from the query engine through our logger.
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  onModuleInit(): void {
    // Connect in the background rather than awaiting here: awaiting would block
    // NestFactory.create() (and therefore app.listen()) until the DB handshake
    // completes, so a slow connection would keep the HTTP server from binding
    // and make a healthcheck-gated deploy fail even though the app is fine.
    // Prisma also connects lazily on first query, so this is purely a warm-up.
    this.$connect()
      .then(() => this.logger.log('Prisma connected to the database'))
      .catch((err) =>
        this.logger.error('Prisma failed to connect on startup (will retry lazily)', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected from the database');
  }

  /** Lightweight connectivity probe used by the health endpoint. */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
