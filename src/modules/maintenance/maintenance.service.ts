import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * One-off data maintenance used to clear seed/demo placeholder data before the
 * first real influence-stats import. Kept narrow and auditable: it only matches
 * the well-known demo markers (the `prisma/seed.ts` creator + any @example.com
 * address), returns exactly what it will remove, and supports a dry run.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** WHERE clause identifying demo/seed creators — deliberately conservative. */
  private demoWhere(): Prisma.CreatorWhereInput {
    return {
      OR: [
        { email: { endsWith: '@example.com', mode: 'insensitive' } },
        { instagramUsername: { in: ['democreator', 'demo_creator'] } },
        { creatorName: { in: ['Demo Creator', 'Test Creator'], mode: 'insensitive' } },
      ],
    };
  }

  /**
   * Delete demo/seed creators (cascades to their stats + contracts). Pass
   * `dryRun` to preview the matches without deleting. Also removes the seed
   * demo campaign when it's left with no creators.
   */
  async purgeDemo(dryRun = false) {
    const where = this.demoWhere();
    const matched = await this.prisma.creator.findMany({
      where,
      select: { id: true, creatorName: true, email: true, instagramUsername: true },
    });

    if (dryRun) {
      return { dryRun: true, matchedCount: matched.length, matched };
    }

    const del = await this.prisma.creator.deleteMany({ where });

    // Clean up the seed demo campaign if nothing else references it.
    let campaignRemoved = false;
    const demoCampaign = await this.prisma.campaign.findFirst({
      where: {
        OR: [{ instantlyCampaignId: 'demo-campaign-0001' }, { name: 'Summer Launch 2026' }],
      },
      include: { _count: { select: { creators: true } } },
    });
    if (demoCampaign && demoCampaign._count.creators === 0) {
      await this.prisma.campaign.delete({ where: { id: demoCampaign.id } });
      campaignRemoved = true;
    }

    this.logger.log(`Purged ${del.count} demo creator(s)${campaignRemoved ? ' + demo campaign' : ''}`);
    return { dryRun: false, deletedCount: del.count, deleted: matched, campaignRemoved };
  }
}
