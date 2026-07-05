import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { EmailHistory, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface UpsertMessageInput {
  threadId: string;
  messageId: string;
  sender?: string | null;
  recipient?: string | null;
  subject?: string | null;
  timestamp?: Date | null;
  rawEmail?: string | null;
  creatorId?: string | null;
}

export interface UpsertMessageResult {
  created: boolean;
  changed: boolean;
}

/**
 * Persistence for fetched email messages and their Claude extractions.
 *
 * A message's `contentHash` lets us cheaply detect edited threads: when the
 * hash changes we reset `processedAt` to null so Claude re-analyses the thread.
 * `processedAt = null` is the single source of truth for "needs extraction",
 * which is exactly what Job 3 keys off (new emails, edited threads, new replies).
 */
@Injectable()
export class EmailHistoryService {
  private readonly logger = new Logger(EmailHistoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  private hashContent(subject?: string | null, rawEmail?: string | null): string {
    return createHash('sha256')
      .update(`${subject ?? ''}\n${rawEmail ?? ''}`)
      .digest('hex');
  }

  /**
   * Insert or update a message keyed by its Instantly message id. Returns
   * whether the row was created and whether its content actually changed (which
   * determines if the owning thread needs re-extraction).
   */
  async upsertMessage(input: UpsertMessageInput): Promise<UpsertMessageResult> {
    const contentHash = this.hashContent(input.subject, input.rawEmail);
    const existing = await this.prisma.emailHistory.findUnique({
      where: { messageId: input.messageId },
    });

    if (existing) {
      if (existing.contentHash === contentHash) {
        // Content unchanged: only fill in the creator link if newly resolved.
        if (input.creatorId && !existing.creatorId) {
          await this.prisma.emailHistory.update({
            where: { messageId: input.messageId },
            data: { creatorId: input.creatorId },
          });
        }
        return { created: false, changed: false };
      }

      // Content edited → reset processedAt so Claude re-analyses the thread.
      await this.prisma.emailHistory.update({
        where: { messageId: input.messageId },
        data: {
          threadId: input.threadId,
          sender: input.sender ?? undefined,
          recipient: input.recipient ?? undefined,
          subject: input.subject ?? undefined,
          timestamp: input.timestamp ?? undefined,
          rawEmail: input.rawEmail ?? undefined,
          contentHash,
          processedAt: null,
          creatorId: input.creatorId ?? existing.creatorId ?? undefined,
        },
      });
      return { created: false, changed: true };
    }

    await this.prisma.emailHistory.create({
      data: {
        threadId: input.threadId,
        messageId: input.messageId,
        sender: input.sender ?? undefined,
        recipient: input.recipient ?? undefined,
        subject: input.subject ?? undefined,
        timestamp: input.timestamp ?? undefined,
        rawEmail: input.rawEmail ?? undefined,
        contentHash,
        creatorId: input.creatorId ?? undefined,
        processedAt: null,
      },
    });
    return { created: true, changed: true };
  }

  /** Distinct thread ids that contain at least one unprocessed message. */
  async findThreadIdsNeedingExtraction(limit = 50): Promise<string[]> {
    const rows = await this.prisma.emailHistory.findMany({
      where: { processedAt: null },
      distinct: ['threadId'],
      select: { threadId: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((r) => r.threadId);
  }

  /** All messages in a thread, oldest first, for building the Claude prompt. */
  getThreadMessages(threadId: string): Promise<EmailHistory[]> {
    return this.prisma.emailHistory.findMany({
      where: { threadId },
      orderBy: [{ timestamp: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Mark every message in a thread processed and stash the Claude JSON on them. */
  async markThreadProcessed(threadId: string, claudeJson: Prisma.InputJsonValue): Promise<void> {
    await this.prisma.emailHistory.updateMany({
      where: { threadId },
      data: { processedAt: new Date(), claudeJson },
    });
  }

  /** Link every message in a thread to a resolved creator (fill-only). */
  async linkThreadToCreator(threadId: string, creatorId: string): Promise<void> {
    await this.prisma.emailHistory.updateMany({
      where: { threadId, creatorId: null },
      data: { creatorId },
    });
  }

  countPendingThreads(): Promise<number> {
    return this.prisma.emailHistory
      .findMany({
        where: { processedAt: null },
        distinct: ['threadId'],
        select: { threadId: true },
      })
      .then((rows) => rows.length);
  }
}
