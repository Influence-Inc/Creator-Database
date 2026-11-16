import { Injectable, Logger } from '@nestjs/common';
import { JobType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/** Stack traces are useful, novels are not — cap what's stored per failure. */
export const MAX_ERROR_CHARS = 4000;

/**
 * Dead-letter queue for jobs that fail after their in-service retries are
 * exhausted (a bad lead, an un-extractable thread, an Instantly outage mid-run).
 * Failures are recorded here rather than lost, so they can be inspected and
 * replayed manually without blocking the rest of the sync.
 *
 * Bounded on purpose. The syncs re-read the same upstream items every run (the
 * email job re-fetches the latest ~500 messages every 10 minutes), so an item
 * that fails once usually fails every run. Inserting a fresh row each time —
 * which this used to do, with the whole raw email/lead as the payload — grew
 * the table without limit and filled the Postgres volume. Now:
 *
 *   - callers pass a small identifying payload (ids, not bodies);
 *   - a repeat failure of the same unresolved (jobType, payload) bumps
 *     `attempts` and refreshes `error` on the existing row instead of inserting;
 *   - the stored error is truncated to MAX_ERROR_CHARS.
 *
 * Old rows are pruned by RetentionService.
 */
@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(jobType: JobType, payload: Prisma.InputJsonValue, error: unknown): Promise<void> {
    const raw = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const message = raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS)}…` : raw;
    try {
      const existing = await this.prisma.failedJob.findFirst({
        where: { jobType, resolved: false, payload: { equals: payload } },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.failedJob.update({
          where: { id: existing.id },
          data: { error: message, attempts: { increment: 1 } },
        });
      } else {
        await this.prisma.failedJob.create({
          data: { jobType, payload, error: message },
        });
      }
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
