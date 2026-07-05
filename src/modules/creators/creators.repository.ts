import { Injectable } from '@nestjs/common';
import { Creator, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueryCreatorsDto } from './dto/query-creators.dto';

type Db = PrismaService | Prisma.TransactionClient;

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
   */
  async search(query: QueryCreatorsDto): Promise<{ data: Creator[]; total: number }> {
    const where = this.buildWhere(query);
    const orderBy: Prisma.CreatorOrderByWithRelationInput = {
      [query.sortBy]: query.sortOrder,
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.creator.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.creator.count({ where }),
    ]);

    return { data, total };
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

    return and.length > 0 ? { AND: and } : {};
  }
}
