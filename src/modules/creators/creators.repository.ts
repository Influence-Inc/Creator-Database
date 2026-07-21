import { Injectable } from '@nestjs/common';
import { Creator, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueryCreatorsDto } from './dto/query-creators.dto';

type Db = PrismaService | Prisma.TransactionClient;

/** A Creator row plus a `contractsCount` derived from the Prisma `_count`.
 *  Used by search results and the categorize endpoint so the caller can render
 *  the Used/Unused badge without a second round-trip. */
export type CreatorWithContractCount = Creator & { contractsCount: number };

/**
 * Data-access layer for creators. Holds all Prisma queries so services stay
 * focused on business logic (merge rules, validation, orchestration).
 */
@Injectable()
export class CreatorsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string, db: Db = this.prisma): Promise<Creator | null> {
    return db.creator.findUnique({ where: { id } });
  }

  findByEmail(email: string, db: Db = this.prisma): Promise<Creator | null> {
    return db.creator.findUnique({ where: { email } });
  }

  findByInstagram(instagramUsername: string, db: Db = this.prisma): Promise<Creator | null> {
    return db.creator.findUnique({ where: { instagramUsername } });
  }

  /**
   * Batch-load creators by Instagram handle with just enough campaign history to
   * decide new-vs-old segmentation: the master campaign plus every contract and
   * per-campaign stats snapshot (each of which names the campaign it belongs to).
   */
  findManyByInstagramWithHistory(instagramUsernames: string[], db: Db = this.prisma) {
    return db.creator.findMany({
      where: { instagramUsername: { in: instagramUsernames } },
      select: {
        id: true,
        creatorName: true,
        instagramUsername: true,
        email: true,
        phoneNumber: true,
        campaignName: true,
        contracts: { select: { campaignName: true, brandName: true, status: true } },
        stats: { select: { campaignName: true, brandName: true, statsCampaignId: true } },
      },
    });
  }

  findByName(creatorName: string, db: Db = this.prisma): Promise<Creator | null> {
    return db.creator.findFirst({ where: { creatorName } });
  }

  // Unchecked variants let callers set scalar foreign keys (campaignId)
  // directly instead of going through relation connect syntax.
  create(data: Prisma.CreatorUncheckedCreateInput, db: Db = this.prisma): Promise<Creator> {
    return db.creator.create({ data });
  }

  update(
    id: string,
    data: Prisma.CreatorUncheckedUpdateInput,
    db: Db = this.prisma,
  ): Promise<Creator> {
    return db.creator.update({ where: { id }, data });
  }

  /**
   * Paginated, filtered, sorted search. Returns the page of rows and the total
   * matching count in a single transaction so `meta.total` is consistent.
   * Each row carries `contractsCount` so the caller can render the Used/Unused
   * badge without a second round-trip.
   */
  async search(query: QueryCreatorsDto): Promise<{ data: CreatorWithContractCount[]; total: number }> {
    const where = this.buildWhere(query);
    const orderBy: Prisma.CreatorOrderByWithRelationInput = {
      [query.sortBy]: query.sortOrder,
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.creator.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.limit,
        include: { _count: { select: { contracts: true } } },
      }),
      this.prisma.creator.count({ where }),
    ]);

    const data: CreatorWithContractCount[] = rows.map((r) => {
      const { _count, ...creator } = r as typeof r & { _count: { contracts: number } };
      return { ...creator, contractsCount: _count.contracts };
    });
    return { data, total };
  }

  /**
   * Bulk-fetch the master rows for a batch of {email, instagramUsername} keys.
   * Returns each match with its `contractsCount` so the caller can classify
   * them as Used (≥1 contract) or Unused (0 contracts) in one query. Empty
   * strings are skipped — the caller has already normalized the inputs.
   */
  async findByIdentityKeys(
    keys: { email?: string | null; instagramUsername?: string | null }[],
    db: Db = this.prisma,
  ): Promise<CreatorWithContractCount[]> {
    const emailSet = new Set<string>();
    const igSet = new Set<string>();
    for (const k of keys) {
      if (k.email) emailSet.add(k.email);
      if (k.instagramUsername) igSet.add(k.instagramUsername);
    }
    if (!emailSet.size && !igSet.size) return [];

    const or: Prisma.CreatorWhereInput[] = [];
    if (emailSet.size) or.push({ email: { in: [...emailSet] } });
    if (igSet.size) or.push({ instagramUsername: { in: [...igSet] } });

    const rows = await db.creator.findMany({
      where: { OR: or },
      include: { _count: { select: { contracts: true } } },
    });
    return rows.map((r) => {
      const { _count, ...creator } = r as typeof r & { _count: { contracts: number } };
      return { ...creator, contractsCount: _count.contracts };
    });
  }

  /** Translate the query DTO into a Prisma `where` clause. */
  private buildWhere(query: QueryCreatorsDto): Prisma.CreatorWhereInput {
    const and: Prisma.CreatorWhereInput[] = [];

    if (query.search) {
      const contains = query.search;
      const mode = Prisma.QueryMode.insensitive;
      and.push({
        OR: [
          { creatorName: { contains, mode } },
          { instagramUsername: { contains, mode } },
          { email: { contains, mode } },
          { campaignName: { contains, mode } },
          { assignedManager: { contains, mode } },
        ],
      });
    }

    if (query.status) and.push({ status: query.status });
    if (query.campaignId) and.push({ campaignId: query.campaignId });
    if (query.campaignName) {
      and.push({ campaignName: { contains: query.campaignName, mode: 'insensitive' } });
    }
    if (query.manager) {
      and.push({ assignedManager: { contains: query.manager, mode: 'insensitive' } });
    }
    if (query.instagram) {
      and.push({ instagramUsername: { contains: query.instagram, mode: 'insensitive' } });
    }
    if (query.email) {
      and.push({ email: { contains: query.email, mode: 'insensitive' } });
    }

    // Contract-count category: 'used' = at least one contract row, 'unused' =
    // no contract rows. Prisma's `some` / `none` filters compile to a JOIN + a
    // NOT EXISTS respectively, so both are index-friendly against contracts(creatorId).
    if (query.category === 'used') and.push({ contracts: { some: {} } });
    else if (query.category === 'unused') and.push({ contracts: { none: {} } });

    return and.length > 0 ? { AND: and } : {};
  }
}
