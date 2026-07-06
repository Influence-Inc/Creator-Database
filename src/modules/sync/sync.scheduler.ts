import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ClaudeExtractionService } from './claude-extraction.service';
import { EmailSyncService } from './email-sync.service';
import { OutreachSyncService } from './outreach-sync.service';

/**
 * Registers the three background jobs as cron jobs using expressions from
 * config, and guards against overlapping runs (if a run outlasts its interval,
 * the next tick is skipped rather than piling up).
 *
 *   Job 1  outreach dashboard sync   default every 30 min
 *   Job 2  latest email threads      default every 10 min
 *   Job 3  Claude extraction         default every 10 min
 *
 * Scheduling is disabled entirely when ENABLE_SCHEDULER=false, which lets the
 * API run without workers (or the workers run as a separate process).
 */
@Injectable()
export class SyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(SyncScheduler.name);
  private readonly running = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly outreachSync: OutreachSyncService,
    private readonly emailSync: EmailSyncService,
    private readonly claudeExtraction: ClaudeExtractionService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get<boolean>('jobs.enableScheduler')) {
      this.logger.warn('Scheduler disabled (ENABLE_SCHEDULER=false); no cron jobs registered');
      return;
    }

    this.register('outreach-sync', this.config.get<string>('jobs.cronOutreachSync')!, () =>
      this.outreachSync.run(),
    );
    this.register('email-sync', this.config.get<string>('jobs.cronEmailSync')!, () =>
      this.emailSync.run(),
    );
    this.register('claude-extraction', this.config.get<string>('jobs.cronClaudeExtraction')!, () =>
      this.claudeExtraction.run(),
    );
  }

  private register(name: string, expression: string, task: () => Promise<unknown>): void {
    const job = new CronJob(expression, () => {
      void this.runGuarded(name, task);
    });
    this.schedulerRegistry.addCronJob(name, job as unknown as CronJob);
    job.start();
    this.logger.log(`Registered cron job "${name}" (${expression})`);
  }

  /** Run a task unless a previous invocation is still in flight. */
  private async runGuarded(name: string, task: () => Promise<unknown>): Promise<void> {
    if (this.running.has(name)) {
      this.logger.warn(`Skipping "${name}" tick: previous run still in progress`);
      return;
    }
    this.running.add(name);
    try {
      await task();
    } catch (err) {
      // Sync services already handle their own errors, but guard the scheduler
      // so a thrown error never escapes the cron callback.
      this.logger.error(`Cron job "${name}" threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running.delete(name);
    }
  }
}
