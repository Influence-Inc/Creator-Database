import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { InstagramDmService } from './instagram-dm.service';

/**
 * Polls the company Instagram inbox on a schedule.
 *
 * The webhook is the better route when it works, but it depends on Meta
 * choosing to call us, and several things silently stop that: the account's
 * "Allow access to messages" toggle, a message left unaccepted in the Requests
 * folder, app-mode restrictions on the sender. None of those surface as an
 * error — they just look like silence.
 *
 * Polling removes that dependency: scouts' shares land on their sheets within
 * a couple of minutes whether or not a webhook ever arrives. The two routes are
 * safe to run together because ingestion is keyed on Meta's message id, so a
 * message seen both ways is filed once.
 */
@Injectable()
export class InstagramInboxScheduler implements OnModuleInit {
  private readonly logger = new Logger(InstagramInboxScheduler.name);
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly dm: InstagramDmService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get<boolean>('jobs.enableScheduler')) return;

    // Without a token there is nothing to poll with, and a job that fails every
    // tick is just noise in the logs.
    if (!this.config.get<string>('instagramDm.accessToken')) {
      this.logger.warn(
        'INSTAGRAM_ACCESS_TOKEN is not set — inbox polling disabled. Scout DMs will only arrive if the webhook works.',
      );
      return;
    }

    const expression = this.config.get<string>('jobs.cronInstagramInbox')!;
    const job = new CronJob(expression, () => {
      void this.tick();
    });
    this.schedulerRegistry.addCronJob('instagram-inbox', job as unknown as CronJob);
    job.start();
    this.logger.log(`Registered cron job "instagram-inbox" (${expression})`);
  }

  /** One poll, skipped if the previous one is still in flight. */
  private async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('Skipping inbox poll: previous run still in progress');
      return;
    }
    this.running = true;
    try {
      const res = await this.dm.syncInbox();
      if (!res.ok) {
        this.logger.warn(`Inbox poll could not read the inbox: ${res.error}`);
        return;
      }
      // Only worth a line when something actually changed; a quiet inbox is the
      // normal case and shouldn't fill the log every couple of minutes.
      if (res.filed > 0 || res.unmatched > 0) {
        this.logger.log(
          `Inbox poll filed ${res.filed} message(s), ${res.unmatched} from unlinked senders`,
        );
      }
    } catch (err) {
      this.logger.error(`Inbox poll threw: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
