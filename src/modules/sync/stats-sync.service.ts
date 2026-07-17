import { Injectable, Logger } from '@nestjs/common';
import { ActivitySource, JobType, Prisma } from '@prisma/client';
import { StatsService } from '../../integrations/stats/stats.service';
import { mapStatsToCreator, mapStatsToSnapshot } from '../../integrations/stats/stats.mapper';
import { StatsCampaign, StatsCreator } from '../../integrations/stats/stats.types';
import { CreatorStatsService } from '../creator-stats/creator-stats.service';
import { CreatorsService } from '../creators/creators.service';
import { DeadLetterService } from './dead-letter.service';
import { SyncRunService } from './sync-run.service';
import { SyncResult, emptyCounters } from './sync-result.interface';

/**
 * Job 4 — import creator performance from the influence-stats (ReelMetrics)
 * service.
 *
 * Flow: fetch every campaign + creator from `GET /api/bot/campaigns` → resolve
 * (or create) the master Creator by identity, folding in the analytics summary
 * (risk, CPM, average views/likes, engagement) → upsert a per-campaign snapshot
 * row into creator_stats (combined totals, commercials, deliverables, per-post
 * breakdown). A failed creator is dead-lettered and the run continues.
 *
 * The job is skipped when STATS_API_URL is not configured.
 */
@Injectable()
export class StatsSyncService {
  private readonly logger = new Logger(StatsSyncService.name);

  constructor(
    private readonly stats: StatsService,
    private readonly creators: CreatorsService,
    private readonly creatorStats: CreatorStatsService,
    private readonly deadLetter: DeadLetterService,
    private readonly syncRun: SyncRunService,
  ) {}

  async run(): Promise<SyncResult> {
    const run = await this.syncRun.start(JobType.STATS_SYNC);
    const counters = emptyCounters();

    if (!this.stats.isConfigured()) {
      this.logger.warn('Stats sync skipped: STATS_API_URL not configured');
      return this.syncRun.succeed(run, counters);
    }

    this.logger.log('Stats sync started', { runId: run.id });

    try {
      const { campaigns = [] } = await this.stats.fetchCampaigns();

      for (const campaign of campaigns) {
        for (const creator of campaign.creators ?? []) {
          counters.processed += 1;
          try {
            const changed = await this.syncCreator(campaign, creator);
            if (changed === 'created') counters.created += 1;
            else if (changed === 'updated') counters.updated += 1;
          } catch (err) {
            counters.failed += 1;
            await this.deadLetter.record(
              JobType.STATS_SYNC,
              {
                statsCampaignId: campaign.id,
                username: creator.username,
                email: creator.email,
              } as Prisma.InputJsonValue,
              err,
            );
          }
        }
      }

      const result = await this.syncRun.succeed(run, counters);
      this.logger.log('Stats sync finished', { ...result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result = await this.syncRun.fail(run, counters, message);
      this.logger.error('Stats sync failed', { runId: run.id, error: message });
      return result;
    }
  }

  /**
   * Resolve/merge the master creator and upsert its per-campaign snapshot.
   * Returns 'created' | 'updated' | 'skipped' to drive the run counters.
   */
  private async syncCreator(
    campaign: StatsCampaign,
    creator: StatsCreator,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const creatorInput = mapStatsToCreator(creator);
    const result = await this.creators.upsertFromSource(creatorInput, ActivitySource.STATS_SYNC);
    if (!result.creator) return 'skipped'; // no identity → nothing to attach stats to

    const snapshot = mapStatsToSnapshot(creator, campaign);
    if (snapshot) {
      await this.creatorStats.upsertFromStats(result.creator.id, snapshot);
    }

    return result.created ? 'created' : 'updated';
  }
}
