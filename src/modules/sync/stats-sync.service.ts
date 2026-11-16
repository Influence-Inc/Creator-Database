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
import { RankedRow, collapseByCreator } from './collapse-by-creator';

interface StatsRow {
  campaign: StatsCampaign;
  creator: StatsCreator;
}

/** Identify a stats row in the dead-letter queue. */
function statsRef({ campaign, creator }: StatsRow): Prisma.InputJsonValue {
  return {
    statsCampaignId: campaign.id ?? null,
    username: creator.username ?? null,
    email: creator.email ?? null,
  } as Prisma.InputJsonValue;
}

/**
 * Job 4 — import creator performance from the influence-stats (ReelMetrics)
 * service.
 *
 * Flow: fetch every campaign + creator from `GET /api/bot/campaigns` → fold
 * each creator's rows across campaigns (newest campaign wins) → resolve (or
 * create) the master Creator by identity once, folding in the analytics summary
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

      // A creator can appear in several campaigns. Saving the master record once
      // per campaign flipped averageViews / cpm / engagement between campaigns
      // every run, logging each flip. Fold first: the newest campaign supplies
      // the master record's figures; every campaign still gets its own snapshot.
      const rows: RankedRow<StatsRow>[] = [];
      for (const campaign of campaigns) {
        for (const creator of campaign.creators ?? []) {
          counters.processed += 1;
          rows.push({
            input: mapStatsToCreator(creator),
            rank: typeof campaign.createdAt === 'number' ? campaign.createdAt : 0,
            tiebreak: String(campaign.id ?? ''),
            item: { campaign, creator },
          });
        }
      }

      for (const group of collapseByCreator(rows)) {
        let creatorId: string;
        let created = false;
        try {
          const result = await this.creators.upsertFromSource(
            group.input,
            ActivitySource.STATS_SYNC,
          );
          if (!result.creator) continue; // no identity → nothing to attach stats to
          creatorId = result.creator.id;
          created = result.created;
        } catch (err) {
          counters.failed += group.rows.length;
          await this.deadLetter.record(JobType.STATS_SYNC, statsRef(group.rows[0].item), err);
          continue;
        }

        // Counted per row, as before: the first row of a new creator is the
        // "created" one, everything else an update.
        for (const [i, { item }] of group.rows.entries()) {
          try {
            const snapshot = mapStatsToSnapshot(item.creator, item.campaign);
            if (snapshot) await this.creatorStats.upsertFromStats(creatorId, snapshot);
            if (i === 0 && created) counters.created += 1;
            else counters.updated += 1;
          } catch (err) {
            counters.failed += 1;
            await this.deadLetter.record(JobType.STATS_SYNC, statsRef(item), err);
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
}
