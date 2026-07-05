import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Campaign, Prisma } from '@prisma/client';
import { buildPaginatedResponse, PaginatedResponse } from '../../common/dto/paginated-response.dto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueryCampaignsDto } from './dto/query-campaigns.dto';

type Db = PrismaService | Prisma.TransactionClient;

export interface CampaignUpsertInput {
  name: string;
  instantlyCampaignId?: string | null;
  brandName?: string | null;
  data?: Prisma.InputJsonValue;
}

/**
 * Campaigns are synced from Instantly (one row per campaign). The outreach sync
 * upserts them; the REST API exposes a read-only list with creator counts.
 */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert a campaign, keyed by the Instantly campaign UUID when available and
   * by name otherwise. Returns the persisted row so callers can link creators.
   */
  async upsert(input: CampaignUpsertInput, db: Db = this.prisma): Promise<Campaign> {
    const base = {
      name: input.name,
      instantlyCampaignId: input.instantlyCampaignId ?? undefined,
      brandName: input.brandName ?? undefined,
      data: input.data ?? undefined,
      syncedAt: new Date(),
    };

    if (input.instantlyCampaignId) {
      return db.campaign.upsert({
        where: { instantlyCampaignId: input.instantlyCampaignId },
        update: base,
        create: base,
      });
    }

    return db.campaign.upsert({
      where: { name: input.name },
      update: base,
      create: base,
    });
  }

  /** Paginated list of campaigns, each annotated with its creator count. */
  async findMany(query: QueryCampaignsDto): Promise<PaginatedResponse<unknown>> {
    const where: Prisma.CampaignWhereInput = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { brandName: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [data, total] = await this.prisma.$transaction([
      this.prisma.campaign.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.limit,
        include: { _count: { select: { creators: true } } },
      }),
      this.prisma.campaign.count({ where }),
    ]);

    const shaped = data.map((c) => ({
      ...c,
      creatorCount: c._count.creators,
      _count: undefined,
    }));

    return buildPaginatedResponse(shaped, total, query.page, query.limit);
  }

  async findOne(id: string): Promise<Campaign> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return campaign;
  }

  count(): Promise<number> {
    return this.prisma.campaign.count();
  }
}
