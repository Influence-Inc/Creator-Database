import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ClaudeExtractionService } from './claude-extraction.service';
import { EmailSyncService } from './email-sync.service';
import { OutreachSyncService } from './outreach-sync.service';
import { SyncResult } from './sync-result.interface';

/**
 * Manual triggers for the three background jobs. Each runs the same code path
 * as the scheduler and returns the run summary, so operators can force a sync
 * on demand (e.g. after fixing a mapping) without waiting for the next tick.
 *
 *   POST /sync/outreach   run Job 1 now
 *   POST /sync/emails     run Job 2 now
 *   POST /sync/claude     run Job 3 now
 */
@Controller('sync')
export class SyncController {
  constructor(
    private readonly outreachSync: OutreachSyncService,
    private readonly emailSync: EmailSyncService,
    private readonly claudeExtraction: ClaudeExtractionService,
  ) {}

  @Post('outreach')
  @HttpCode(HttpStatus.OK)
  runOutreach(): Promise<SyncResult> {
    return this.outreachSync.run();
  }

  @Post('emails')
  @HttpCode(HttpStatus.OK)
  runEmails(): Promise<SyncResult> {
    return this.emailSync.run();
  }

  @Post('claude')
  @HttpCode(HttpStatus.OK)
  runClaude(): Promise<SyncResult> {
    return this.claudeExtraction.run();
  }
}
