import { Module } from '@nestjs/common';
import { ClaudeModule } from '../../integrations/claude/claude.module';
import { InstantlyModule } from '../../integrations/instantly/instantly.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { CreatorsModule } from '../creators/creators.module';
import { EmailHistoryModule } from '../email-history/email-history.module';
import { ClaudeExtractionService } from './claude-extraction.service';
import { DeadLetterService } from './dead-letter.service';
import { EmailSyncService } from './email-sync.service';
import { OutreachSyncService } from './outreach-sync.service';
import { SyncController } from './sync.controller';
import { SyncRunService } from './sync-run.service';
import { SyncScheduler } from './sync.scheduler';

/**
 * Wires the sync pipeline: the three job services, run tracking, the
 * dead-letter queue, the manual-trigger controller, and the cron scheduler.
 */
@Module({
  imports: [InstantlyModule, ClaudeModule, CreatorsModule, CampaignsModule, EmailHistoryModule],
  controllers: [SyncController],
  providers: [
    SyncRunService,
    DeadLetterService,
    OutreachSyncService,
    EmailSyncService,
    ClaudeExtractionService,
    SyncScheduler,
  ],
  exports: [OutreachSyncService, EmailSyncService, ClaudeExtractionService],
})
export class SyncModule {}
