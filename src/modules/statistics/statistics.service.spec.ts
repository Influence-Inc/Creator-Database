import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StatisticsService } from './statistics.service';

describe('StatisticsService', () => {
  it('aggregates counts, averages and derived metrics', async () => {
    const prisma = {
      creator: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'ACCEPTED', _count: { _all: 3 } },
          { status: 'PENDING', _count: { _all: 2 } },
          { status: 'COMPLETED', _count: { _all: 1 } },
        ]),
        aggregate: jest.fn().mockResolvedValue({
          _avg: { cpm: 15.555, acceptedRate: 40000, guaranteedViews: 2_000_000 },
        }),
        // Called in order: upcomingDeadlines, pendingDeliverables, total.
        count: jest
          .fn()
          .mockResolvedValueOnce(4) // upcoming deadlines
          .mockResolvedValueOnce(5) // pending deliverables
          .mockResolvedValueOnce(6), // total creators
      },
      campaign: { count: jest.fn().mockResolvedValue(2) },
    } as unknown as PrismaService;

    const config = { get: jest.fn().mockReturnValue(30) } as unknown as ConfigService;

    const service = new StatisticsService(prisma, config);
    const stats = await service.getStatistics();

    expect(stats.totalCreators).toBe(6);
    expect(stats.accepted).toBe(3);
    expect(stats.pending).toBe(2);
    expect(stats.completed).toBe(1);
    expect(stats.negotiating).toBe(0);
    expect(stats.byStatus.ACCEPTED).toBe(3);
    expect(stats.averageCpm).toBe(15.56); // rounded to 2dp
    expect(stats.averageAcceptedRate).toBe(40000);
    expect(stats.averageGuaranteedViews).toBe(2_000_000);
    expect(stats.campaignCount).toBe(2);
    expect(stats.upcomingDeadlines).toBe(4);
    expect(stats.pendingDeliverables).toBe(5);
  });
});
