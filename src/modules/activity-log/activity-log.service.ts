import { Injectable, Logger } from '@nestjs/common';
import { ActivitySource, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityChange } from './activity-change.interface';

/** Prisma client type that can be either the base client or a tx client. */
type Db = PrismaService | Prisma.TransactionClient;

/**
 * Append-only audit trail. Every mutation to a creator record — whether from
 * outreach sync, Claude extraction or the manual API — is recorded here as one
 * row per changed field, so we can answer "who/what changed this and when".
 */
@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a batch of field changes for a creator. Accepts an optional
   * transaction client so the log is written atomically with the update that
   * produced it.
   */
  async record(
    creatorId: string,
    changes: ActivityChange[],
    source: ActivitySource,
    db: Db = this.prisma,
  ): Promise<void> {
    if (changes.length === 0) return;

    await db.activityLog.createMany({
      data: changes.map((change) => ({
        creatorId,
        changedField: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        source,
      })),
    });

    this.logger.debug(`Recorded ${changes.length} change(s) for creator ${creatorId}`, {
      creatorId,
      source,
      fields: changes.map((c) => c.field),
    });
  }

  /** List recent activity for a creator (newest first). */
  findByCreator(creatorId: string, limit = 100) {
    return this.prisma.activityLog.findMany({
      where: { creatorId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
