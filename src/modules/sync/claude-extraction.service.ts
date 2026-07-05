import { Injectable, Logger } from '@nestjs/common';
import { ActivitySource, JobType, Prisma } from '@prisma/client';
import { ClaudeService } from '../../integrations/claude/claude.service';
import { mapExtractionToCreator } from '../../integrations/claude/claude.mapper';
import { CreatorsService } from '../creators/creators.service';
import { EmailHistoryService } from '../email-history/email-history.service';
import { DeadLetterService } from './dead-letter.service';
import { SyncRunService } from './sync-run.service';
import { SyncResult, emptyCounters } from './sync-result.interface';

/** Cap the number of threads processed per run to bound Claude spend/latency. */
const DEFAULT_BATCH_SIZE = 50;

/**
 * Job 3 — run Claude extraction, but ONLY for threads that need it.
 *
 * A thread "needs extraction" when it has at least one message with
 * `processedAt = null` — i.e. a new email, a new reply, or an edited message
 * (whose content hash changed and reset processedAt). Already-analysed,
 * unchanged threads are never re-sent to Claude.
 *
 * For each thread: build the prompt, extract structured JSON, merge it into the
 * master creator record, link the thread to that creator, and mark the thread
 * processed. A thread that fails extraction is dead-lettered and marked
 * processed-with-error so it doesn't hot-loop.
 */
@Injectable()
export class ClaudeExtractionService {
  private readonly logger = new Logger(ClaudeExtractionService.name);

  constructor(
    private readonly claude: ClaudeService,
    private readonly creators: CreatorsService,
    private readonly emailHistory: EmailHistoryService,
    private readonly deadLetter: DeadLetterService,
    private readonly syncRun: SyncRunService,
  ) {}

  async run(batchSize = DEFAULT_BATCH_SIZE): Promise<SyncResult> {
    const run = await this.syncRun.start(JobType.CLAUDE_EXTRACTION);
    const counters = emptyCounters();
    this.logger.log('Claude extraction started', { runId: run.id, batchSize });

    try {
      const threadIds = await this.emailHistory.findThreadIdsNeedingExtraction(batchSize);

      for (const threadId of threadIds) {
        counters.processed += 1;
        try {
          await this.processThread(threadId, counters);
        } catch (err) {
          counters.failed += 1;
          await this.deadLetter.record(
            JobType.CLAUDE_EXTRACTION,
            { threadId } as Prisma.InputJsonValue,
            err,
          );
          // Mark processed-with-error so a permanently bad thread isn't retried
          // every run. It remains in the dead-letter queue for manual replay.
          await this.emailHistory.markThreadProcessed(threadId, {
            error: err instanceof Error ? err.message : String(err),
            failedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue);
        }
      }

      const result = await this.syncRun.succeed(run, counters);
      this.logger.log('Claude extraction finished', { ...result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result = await this.syncRun.fail(run, counters, message);
      this.logger.error('Claude extraction failed', { runId: run.id, error: message });
      return result;
    }
  }

  private async processThread(
    threadId: string,
    counters: { created: number; updated: number },
  ): Promise<void> {
    const messages = await this.emailHistory.getThreadMessages(threadId);
    if (messages.length === 0) {
      await this.emailHistory.markThreadProcessed(threadId, {} as Prisma.InputJsonValue);
      return;
    }

    const extraction = await this.claude.extractFromThread(
      messages.map((m) => ({
        sender: m.sender,
        recipient: m.recipient,
        subject: m.subject,
        timestamp: m.timestamp,
        rawEmail: m.rawEmail,
      })),
    );

    const lastReplyDate = messages[messages.length - 1].timestamp ?? undefined;
    const input = mapExtractionToCreator(extraction, { threadId, lastReplyDate });

    const result = await this.creators.upsertFromSource(input, ActivitySource.CLAUDE_EXTRACTION);
    if (result.creator) {
      await this.emailHistory.linkThreadToCreator(threadId, result.creator.id);
    }
    if (result.created) counters.created += 1;
    else if (result.changed) counters.updated += 1;

    // Persist the structured extraction on the thread and mark it processed.
    await this.emailHistory.markThreadProcessed(
      threadId,
      extraction as unknown as Prisma.InputJsonValue,
    );
  }
}
