import { Module } from '@nestjs/common';
import { ClaudeModule } from '../../integrations/claude/claude.module';
import { InstantlyModule } from '../../integrations/instantly/instantly.module';
import { StatsModule } from '../../integrations/stats/stats.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { CreatorsModule } from '../creators/creators.module';
import { CreatorStatsModule } from '../creator-stats/creator-stats.module';
import { EmailHistoryModule } from '../email-history/email-history.module';
import { ClaudeExtractionService } from './claude-extraction.service';
import { DeadLetterService } from './dead-letter.service';
import { EmailSyncService } from './email-sync.service';
import { OutreachSyncService } from './outreach-sync.service';
import { StatsSyncService } from './stats-sync.service';
import { SyncController } from './sync.controller';
import { SyncRunService } from './sync-run.service';
import { SyncScheduler } from './sync.scheduler';

/**
 * Wires the sync pipeline: the three job services, run tracking, the
 * dead-letter queue, the manual-trigger controller, and the cron scheduler.
 */
@Module({
  imports: [
    InstantlyModule,
    ClaudeModule,
    StatsModule,
    CreatorsModule,
    CreatorStatsModule,
    CampaignsModule,
    EmailHistoryModule,
  ],
  controllers: [SyncController],
  providers: [
    SyncRunService,
    DeadLetterService,
    OutreachSyncService,
    EmailSyncService,
    ClaudeExtractionService,
    StatsSyncService,
    SyncScheduler,
  ],
  exports: [OutreachSyncService, EmailSyncService, ClaudeExtractionService, StatsSyncService],
})
export class SyncModule {}
