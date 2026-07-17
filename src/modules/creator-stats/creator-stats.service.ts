import { Injectable } from '@nestjs/common';
import { CreatorStats, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * The full set of per-campaign stats fields synced from influence-stats. Every
 * field is optional except `statsCampaignId` (the upsert key alongside the
 * creator). `undefined`/`null` are simply not written.
 */
export interface CreatorStatsInput {
  statsCampaignId: string;
  campaignName?: string | null;
  brandName?: string | null;
  platforms?: string | null;

  totalViews?: number | null;
  totalLikes?: number | null;
  totalComments?: number | null;
  postCount?: number | null;
  videosPosted?: number | null;

  riskLevel?: string | null;
  bookedCpm?: number | null;
  realizedCpm?: number | null;
  budget?: number | null;
  grossPay?: number | null;
  creatorAsk?: number | null;
  currency?: string | null;
  paidAdRights?: string | null;

  minViews?: number | null;
  minVideos?: number | null;
  deliverablesComplete?: boolean | null;
  deadline?: Date | null;

  videos?: Prisma.InputJsonValue | null;
}

/**
 * Persists the per-creator, per-campaign performance snapshots synced from
 * influence-stats into the `creator_stats` table. One row per
 * (creatorId, statsCampaignId); a re-sync updates the existing row rather than
 * duplicating it.
 */
@Injectable()
export class CreatorStatsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create-or-update the stats snapshot for a creator + stats campaign. */
  async upsertFromStats(creatorId: string, input: CreatorStatsInput): Promise<CreatorStats> {
    const data = {
      campaignName: input.campaignName ?? undefined,
      brandName: input.brandName ?? undefined,
      platforms: input.platforms ?? undefined,
      totalViews: input.totalViews ?? undefined,
      totalLikes: input.totalLikes ?? undefined,
      totalComments: input.totalComments ?? undefined,
      postCount: input.postCount ?? undefined,
      videosPosted: input.videosPosted ?? undefined,
      riskLevel: input.riskLevel ?? undefined,
      bookedCpm: input.bookedCpm ?? undefined,
      realizedCpm: input.realizedCpm ?? undefined,
      budget: input.budget ?? undefined,
      grossPay: input.grossPay ?? undefined,
      creatorAsk: input.creatorAsk ?? undefined,
      currency: input.currency ?? undefined,
      paidAdRights: input.paidAdRights ?? undefined,
      minViews: input.minViews ?? undefined,
      minVideos: input.minVideos ?? undefined,
      deliverablesComplete: input.deliverablesComplete ?? undefined,
      deadline: input.deadline ?? undefined,
      videos: input.videos ?? undefined,
      syncedAt: new Date(),
    };

    return this.prisma.creatorStats.upsert({
      where: { creatorId_statsCampaignId: { creatorId, statsCampaignId: input.statsCampaignId } },
      create: { creatorId, statsCampaignId: input.statsCampaignId, ...data },
      update: data,
    });
  }

  /** All stats snapshots for a creator, newest sync first. */
  findByCreator(creatorId: string): Promise<CreatorStats[]> {
    return this.prisma.creatorStats.findMany({
      where: { creatorId },
      orderBy: { syncedAt: 'desc' },
    });
  }
}
