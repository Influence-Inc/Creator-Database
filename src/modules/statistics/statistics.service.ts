import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NegotiationStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface StatisticsResponse {
  totalCreators: number;
  byStatus: Record<NegotiationStatus, number>;
  negotiating: number;
  accepted: number;
  completed: number;
  pending: number;
  rejected: number;
  averageCpm: number | null;
  averageAcceptedRate: number | null;
  averageGuaranteedViews: number | null;
  campaignCount: number;
  upcomingDeadlines: number;
  pendingDeliverables: number;
  generatedAt: string;
}

/** Round to 2 decimals, preserving null. */
function round2(value: number | null): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Aggregate dashboard metrics for `GET /statistics`. All numbers come straight
 * from indexed Prisma aggregates/group-bys so the endpoint stays fast even with
 * tens of thousands of creators.
 */
@Injectable()
export class StatisticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getStatistics(): Promise<StatisticsResponse> {
    const now = new Date();
    const horizonDays = this.config.get<number>('jobs.upcomingDeadlineDays') ?? 30;
    const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

    const [
      grouped,
      averages,
      campaignCount,
      upcomingDeadlines,
      pendingDeliverables,
      totalCreators,
    ] = await Promise.all([
      this.prisma.creator.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.creator.aggregate({
        _avg: { cpm: true, acceptedRate: true, guaranteedViews: true },
      }),
      this.prisma.campaign.count(),
      this.prisma.creator.count({
        where: {
          deadline: { gte: now, lte: horizon },
          status: { notIn: [NegotiationStatus.COMPLETED, NegotiationStatus.REJECTED] },
        },
      }),
      this.prisma.creator.count({
        where: {
          status: { in: [NegotiationStatus.ACCEPTED, NegotiationStatus.NEGOTIATING] },
          OR: [
            { numberOfVideos: { gt: 0 } },
            { numberOfStories: { gt: 0 } },
            { numberOfReels: { gt: 0 } },
          ],
        },
      }),
      this.prisma.creator.count(),
    ]);

    const byStatus: Record<NegotiationStatus, number> = {
      PENDING: 0,
      NEGOTIATING: 0,
      ACCEPTED: 0,
      REJECTED: 0,
      COMPLETED: 0,
    };
    for (const row of grouped) {
      byStatus[row.status] = row._count._all;
    }

    return {
      totalCreators,
      byStatus,
      negotiating: byStatus.NEGOTIATING,
      accepted: byStatus.ACCEPTED,
      completed: byStatus.COMPLETED,
      pending: byStatus.PENDING,
      rejected: byStatus.REJECTED,
      averageCpm: round2(averages._avg.cpm),
      averageAcceptedRate: round2(averages._avg.acceptedRate),
      averageGuaranteedViews: round2(averages._avg.guaranteedViews),
      campaignCount,
      upcomingDeadlines,
      pendingDeliverables,
      generatedAt: now.toISOString(),
    };
  }
}
