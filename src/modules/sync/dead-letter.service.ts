import { Injectable, Logger } from '@nestjs/common';
import { JobType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Dead-letter queue for jobs that fail after their in-service retries are
 * exhausted (a bad lead, an un-extractable thread, an Instantly outage mid-run).
 * Failures are recorded here rather than lost, so they can be inspected and
 * replayed manually without blocking the rest of the sync.
 */
@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(jobType: JobType, payload: Prisma.InputJsonValue, error: unknown): Promise<void> {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    try {
      await this.prisma.failedJob.create({
        data: { jobType, payload, error: message },
      });
    } catch (persistErr) {
      // Never let dead-lettering itself break the sync loop.
      this.logger.error('Failed to persist dead-letter record', {
        jobType,
        original: message,
        persistError: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
    }
    this.logger.warn(`Dead-lettered ${jobType} job`, { jobType });
  }

  /** List unresolved dead-letter records (for a future retry/admin endpoint). */
  listUnresolved(limit = 100) {
    return this.prisma.failedJob.findMany({
      where: { resolved: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
