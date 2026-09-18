import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ActivitySource, Prisma, QualificationStatus, ScoutGender, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { normalizeInstagram } from '../../common/utils/normalize';
import { AuthPrincipal } from '../auth/auth.service';
import { CreatorsService } from '../creators/creators.service';

/** Fields a scout may set on their own rows. */
export interface ScoutEditableInput {
  instagramProfileLink?: string;
  reelIdeas?: string | null;
  approxAge?: number | null;
  gender?: ScoutGender | null;
  country?: string | null;
  language?: string | null;
}

/** Fields only an admin may set. */
export interface ScoutReviewInput {
  qualification?: QualificationStatus;
  notes?: string | null;
}

const ENTRY_INCLUDE = {
  scout: { select: { id: true, username: true, displayName: true } },
  reviewedBy: { select: { id: true, username: true, displayName: true } },
  promotedCreator: { select: { id: true, creatorName: true, instagramUsername: true } },
} satisfies Prisma.ScoutEntryInclude;

/**
 * The scouting sheet.
 *
 * Ownership is enforced here rather than in the controller so there is a single
 * place that decides who may see or touch a row: a SCOUT is always scoped to
 * `scoutId = their own user id`, an ADMIN sees everything. Qualification and
 * notes are admin-only — `applyScoutEdits` simply never copies them, so a scout
 * cannot set them even by posting the fields directly.
 */
@Injectable()
export class ScoutsService {
  private readonly logger = new Logger(ScoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creators: CreatorsService,
  ) {}

  /** The scout whose rows this principal may act on, or null for an admin. */
  private ownerScopeFor(principal: AuthPrincipal): string | null {
    if (principal.role === UserRole.ADMIN) return null;
    if (!principal.uid) {
      // A scout session must always be backed by a real user row.
      throw new ForbiddenException('This account cannot access scouting sheets');
    }
    return principal.uid;
  }

  /** Rows visible to the caller. Scouts only ever see their own. */
  async list(
    principal: AuthPrincipal,
    filters: { scoutId?: string; qualification?: QualificationStatus; search?: string } = {},
  ) {
    const ownScope = this.ownerScopeFor(principal);

    const where: Prisma.ScoutEntryWhereInput = {};
    // A scout's scope is non-negotiable; an admin may optionally filter.
    where.scoutId = ownScope ?? (filters.scoutId || undefined);
    if (filters.qualification) where.qualification = filters.qualification;
    if (filters.search?.trim()) {
      const contains = filters.search.trim();
      where.OR = [
        { instagramProfileLink: { contains, mode: 'insensitive' } },
        { instagramUsername: { contains, mode: 'insensitive' } },
        { country: { contains, mode: 'insensitive' } },
        { language: { contains, mode: 'insensitive' } },
      ];
    }

    return this.prisma.scoutEntry.findMany({
      where,
      include: ENTRY_INCLUDE,
      orderBy: ownScope ? { rowNumber: 'asc' } : [{ createdAt: 'desc' }],
    });
  }

  /** Load a row and assert the caller may touch it. */
  private async loadOwned(id: string, principal: AuthPrincipal) {
    const entry = await this.prisma.scoutEntry.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException('Scouting row not found');

    const ownScope = this.ownerScopeFor(principal);
    if (ownScope && entry.scoutId !== ownScope) {
      // Same message as a genuine miss so one scout can't probe for another's rows.
      throw new NotFoundException('Scouting row not found');
    }
    return entry;
  }

  /**
   * Flag an Instagram handle that has already been scouted or already exists as
   * a creator. Returns a message for the UI rather than blocking the save — a
   * scout can't see other sheets, so a hard block would be unexplainable.
   */
  async duplicateWarning(handle: string | null, ignoreEntryId?: string): Promise<string | null> {
    if (!handle) return null;

    const [entry, creator] = await Promise.all([
      this.prisma.scoutEntry.findFirst({
        where: {
          instagramUsername: handle,
          ...(ignoreEntryId ? { id: { not: ignoreEntryId } } : {}),
        },
        select: { id: true },
      }),
      this.prisma.creator.findUnique({
        where: { instagramUsername: handle },
        select: { id: true },
      }),
    ]);

    if (creator) return 'This creator is already in the Creator Database.';
    if (entry) return 'This profile has already been scouted.';
    return null;
  }

  /** Copy only the scout-editable fields. Qualification/notes are never read here. */
  private applyScoutEdits(
    data: Prisma.ScoutEntryUncheckedUpdateInput | Prisma.ScoutEntryUncheckedCreateInput,
    input: ScoutEditableInput,
  ): void {
    const target = data as Record<string, unknown>;
    if (input.instagramProfileLink !== undefined) {
      const link = input.instagramProfileLink.trim();
      target.instagramProfileLink = link;
      target.instagramUsername = normalizeInstagram(link);
    }
    if (input.reelIdeas !== undefined) target.reelIdeas = input.reelIdeas?.trim() || null;
    if (input.approxAge !== undefined) target.approxAge = input.approxAge ?? null;
    if (input.gender !== undefined) target.gender = input.gender ?? null;
    if (input.country !== undefined) target.country = input.country?.trim() || null;
    if (input.language !== undefined) target.language = input.language?.trim() || null;
  }

  /** Append a row to a scout's sheet, numbered sequentially within that sheet. */
  async create(principal: AuthPrincipal, input: ScoutEditableInput & { scoutId?: string }) {
    const ownScope = this.ownerScopeFor(principal);
    const scoutId = ownScope ?? input.scoutId;
    if (!scoutId) {
      throw new ForbiddenException('scoutId is required when creating a row as an admin');
    }

    const link = (input.instagramProfileLink ?? '').trim();
    const handle = normalizeInstagram(link);

    // Retry once on the (scoutId, rowNumber) unique constraint so two rows added
    // at the same moment don't collide on the computed next number.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const last = await this.prisma.scoutEntry.findFirst({
        where: { scoutId },
        orderBy: { rowNumber: 'desc' },
        select: { rowNumber: true },
      });
      const rowNumber = (last?.rowNumber ?? 0) + 1;

      const data: Prisma.ScoutEntryUncheckedCreateInput = {
        scoutId,
        rowNumber,
        instagramProfileLink: link,
        instagramUsername: handle,
      };
      this.applyScoutEdits(data, input);

      try {
        const entry = await this.prisma.scoutEntry.create({ data, include: ENTRY_INCLUDE });
        return { entry, duplicateWarning: await this.duplicateWarning(handle, entry.id) };
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          attempt < 3
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new Error('Could not allocate a row number for the new scouting row');
  }

  /** Edit the scout-editable fields of a row. */
  async update(id: string, principal: AuthPrincipal, input: ScoutEditableInput) {
    const existing = await this.loadOwned(id, principal);

    const data: Prisma.ScoutEntryUncheckedUpdateInput = {};
    this.applyScoutEdits(data, input);

    const entry = await this.prisma.scoutEntry.update({
      where: { id },
      data,
      include: ENTRY_INCLUDE,
    });
    const handle = entry.instagramUsername ?? existing.instagramUsername;
    return { entry, duplicateWarning: await this.duplicateWarning(handle, id) };
  }

  async remove(id: string, principal: AuthPrincipal) {
    await this.loadOwned(id, principal);
    await this.prisma.scoutEntry.delete({ where: { id } });
    return { deleted: true as const };
  }

  /** Admin-only: set the qualification tick/cross and notes on a row. */
  async review(id: string, principal: AuthPrincipal, input: ScoutReviewInput) {
    if (principal.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only an admin can qualify a scouting row');
    }
    const existing = await this.prisma.scoutEntry.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Scouting row not found');

    const data: Prisma.ScoutEntryUncheckedUpdateInput = {
      reviewedAt: new Date(),
      reviewedById: principal.uid ?? null,
    };
    if (input.qualification !== undefined) data.qualification = input.qualification;
    if (input.notes !== undefined) data.notes = input.notes?.trim() || null;

    return this.prisma.scoutEntry.update({ where: { id }, data, include: ENTRY_INCLUDE });
  }

  /**
   * Admin-only: push a qualified row into the Creator Database. Routed through
   * CreatorsService.upsertFromSource so it follows the same identity-resolution
   * and merge rules as every other source — scouting a creator we already know
   * updates that master record instead of creating a duplicate.
   */
  async promote(id: string, principal: AuthPrincipal) {
    if (principal.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only an admin can promote a scouting row');
    }
    const entry = await this.prisma.scoutEntry.findUnique({
      where: { id },
      include: { scout: { select: { username: true, displayName: true } } },
    });
    if (!entry) throw new NotFoundException('Scouting row not found');
    if (entry.qualification !== QualificationStatus.QUALIFIED) {
      throw new ForbiddenException('Only a qualified row can be promoted to the Creator Database');
    }
    if (!entry.instagramUsername) {
      throw new ForbiddenException(
        'This row has no readable Instagram handle, so it cannot be matched to a creator',
      );
    }

    const result = await this.creators.upsertFromSource(
      {
        instagramUsername: entry.instagramUsername,
        instagramProfileLink: entry.instagramProfileLink,
        assignedManager: entry.scout.displayName || entry.scout.username,
      },
      ActivitySource.SCOUT_PROMOTION,
    );

    if (!result.creator) {
      throw new ForbiddenException('Could not create a creator from this row');
    }

    const updated = await this.prisma.scoutEntry.update({
      where: { id },
      data: { promotedCreatorId: result.creator.id, promotedAt: new Date() },
      include: ENTRY_INCLUDE,
    });
    this.logger.log(
      `Promoted scouting row ${entry.rowNumber} (@${entry.instagramUsername}) to creator ${result.creator.id}`,
    );
    return { entry: updated, creatorId: result.creator.id, created: result.created };
  }

  /** Admin dashboard counters. */
  async summary() {
    const [byStatus, totals] = await Promise.all([
      this.prisma.scoutEntry.groupBy({ by: ['qualification'], _count: { _all: true } }),
      this.prisma.scoutEntry.count(),
    ]);
    const counts: Record<string, number> = { PENDING: 0, QUALIFIED: 0, REJECTED: 0 };
    for (const row of byStatus) counts[row.qualification] = row._count._all;
    return { total: totals, ...counts };
  }
}
