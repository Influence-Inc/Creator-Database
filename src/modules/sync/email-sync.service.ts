import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobType, Prisma } from '@prisma/client';
import { InstantlyService } from '../../integrations/instantly/instantly.service';
import { mapEmail } from '../../integrations/instantly/instantly.mapper';
import { EmailHistoryService } from '../email-history/email-history.service';
import { DeadLetterService } from './dead-letter.service';
import { SyncRunService } from './sync-run.service';
import { SyncResult, emptyCounters } from './sync-result.interface';

/**
 * Job 2 — fetch the latest email threads from Instantly into `email_history`.
 *
 * This job only persists messages (and detects edits via content hash). It does
 * NOT call Claude or resolve creators — that's Job 3's responsibility. New or
 * edited messages land with `processedAt = null`, which is exactly what the
 * extraction job picks up.
 */
@Injectable()
export class EmailSyncService {
  private readonly logger = new Logger(EmailSyncService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly instantly: InstantlyService,
    private readonly emailHistory: EmailHistoryService,
    private readonly deadLetter: DeadLetterService,
    private readonly syncRun: SyncRunService,
  ) {}

  async run(): Promise<SyncResult> {
    const run = await this.syncRun.start(JobType.EMAIL_SYNC);
    const counters = emptyCounters();
    this.logger.log('Email sync started', { runId: run.id });

    try {
      const eaccount = this.config.get<string | null>('instantly.eaccount');

      for await (const email of this.instantly.iterateEmails({ eaccount, maxPages: 5 })) {
        counters.processed += 1;
        try {
          const mapped = mapEmail(email);
          if (!mapped) continue; // unmappable (no message id) — skip silently
          const result = await this.emailHistory.upsertMessage(mapped);
          if (result.created) counters.created += 1;
          else if (result.changed) counters.updated += 1;
        } catch (err) {
          counters.failed += 1;
          await this.deadLetter.record(JobType.EMAIL_SYNC, { email } as Prisma.InputJsonValue, err);
        }
      }

      const result = await this.syncRun.succeed(run, counters);
      this.logger.log('Email sync finished', { ...result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result = await this.syncRun.fail(run, counters, message);
      this.logger.error('Email sync failed', { runId: run.id, error: message });
      return result;
    }
  }
}
