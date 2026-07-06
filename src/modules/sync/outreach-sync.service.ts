import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivitySource, JobType, Prisma } from '@prisma/client';
import { InstantlyService } from '../../integrations/instantly/instantly.service';
import { mapLeadToCreator } from '../../integrations/instantly/instantly.mapper';
import { CampaignsService } from '../campaigns/campaigns.service';
import { CreatorsService } from '../creators/creators.service';
import { DeadLetterService } from './dead-letter.service';
import { SyncRunService } from './sync-run.service';
import { SyncResult, emptyCounters } from './sync-result.interface';

/**
 * Job 1 — import creator data from the Instantly outreach dashboard.
 *
 * Flow: upsert campaigns → walk each campaign's leads → map each lead to a
 * creator upsert input → merge into the master record (deduped, changed-fields
 * only). A failed lead is dead-lettered and the run continues.
 */
@Injectable()
export class OutreachSyncService {
  private readonly logger = new Logger(OutreachSyncService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly instantly: InstantlyService,
    private readonly campaigns: CampaignsService,
    private readonly creators: CreatorsService,
    private readonly deadLetter: DeadLetterService,
    private readonly syncRun: SyncRunService,
  ) {}

  async run(): Promise<SyncResult> {
    const run = await this.syncRun.start(JobType.OUTREACH_SYNC);
    const counters = emptyCounters();
    this.logger.log('Outreach sync started', { runId: run.id });

    try {
      const campaignMap = await this.syncCampaigns();
      const scanIds = this.resolveScanIds(campaignMap);

      for (const instantlyId of scanIds) {
        const ctx = instantlyId ? campaignMap.get(instantlyId) : undefined;
        for await (const lead of this.instantly.iterateLeads(instantlyId)) {
          counters.processed += 1;
          try {
            const input = mapLeadToCreator(lead, {
              campaignId: ctx?.localId,
              campaignName: ctx?.name,
            });
            const result = await this.creators.upsertFromSource(
              input,
              ActivitySource.INSTANTLY_DASHBOARD,
            );
            if (result.created) counters.created += 1;
            else if (result.changed) counters.updated += 1;
          } catch (err) {
            counters.failed += 1;
            await this.deadLetter.record(
              JobType.OUTREACH_SYNC,
              { lead } as Prisma.InputJsonValue,
              err,
            );
          }
        }
      }

      const result = await this.syncRun.succeed(run, counters);
      this.logger.log('Outreach sync finished', { ...result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result = await this.syncRun.fail(run, counters, message);
      this.logger.error('Outreach sync failed', { runId: run.id, error: message });
      return result;
    }
  }

  /** Upsert every (in-scope) Instantly campaign and return a lookup map. */
  private async syncCampaigns(): Promise<Map<string, { localId: string; name: string }>> {
    const configuredIds = this.config.get<string[]>('instantly.campaignIds') ?? [];
    const map = new Map<string, { localId: string; name: string }>();

    for await (const campaign of this.instantly.iterateCampaigns()) {
      const instantlyId = typeof campaign.id === 'string' ? campaign.id : undefined;
      if (!instantlyId) continue;
      if (configuredIds.length > 0 && !configuredIds.includes(instantlyId)) continue;

      const name =
        (typeof campaign.name === 'string' && campaign.name) ||
        (typeof campaign.campaign_name === 'string' && campaign.campaign_name) ||
        `Campaign ${instantlyId}`;
      const brandName =
        (typeof campaign.brand_name === 'string' && campaign.brand_name) ||
        (typeof campaign.brandName === 'string' && campaign.brandName) ||
        undefined;

      const local = await this.campaigns.upsert({
        name,
        instantlyCampaignId: instantlyId,
        brandName,
        data: campaign as Prisma.InputJsonValue,
      });
      map.set(instantlyId, { localId: local.id, name: local.name });
    }

    return map;
  }

  /**
   * Decide which campaigns' leads to scan: the configured allow-list, else
   * every discovered campaign, else a single un-scoped pass over all leads.
   */
  private resolveScanIds(
    campaignMap: Map<string, { localId: string; name: string }>,
  ): (string | undefined)[] {
    const configuredIds = this.config.get<string[]>('instantly.campaignIds') ?? [];
    if (configuredIds.length > 0) return configuredIds;
    const discovered = Array.from(campaignMap.keys());
    return discovered.length > 0 ? discovered : [undefined];
  }
}
