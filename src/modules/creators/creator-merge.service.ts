import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ActivitySource, Creator, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';

/**
 * Folds a duplicate Creator record into the one we keep.
 *
 * Duplicates exist because a signed contract can arrive carrying only SOME of a
 * creator's identity keys. Between 2026-07-06 and 2026-07-19 the Outreach
 * backend sent contracts with no Instagram handle whenever the creator row had
 * only an `instagram_url` (the handle fallback landed in 9bcae78). Those
 * contracts resolved against nothing — the master record held the handle but no
 * email, the payload held the signer's email but no handle — so a second,
 * handle-less record was created holding the contact and payout details.
 *
 * A merge moves every relation (contracts, stats, email history, activity) onto
 * the survivor, fills the survivor's EMPTY fields from the duplicate, then
 * deletes the duplicate. Existing survivor values are never overwritten: the
 * duplicate is the newer, thinner record, so on any genuine conflict the
 * long-lived master wins.
 */

/** Fields copied from the duplicate onto the survivor when the survivor's is empty. */
const FILLABLE_FIELDS = [
  'creatorName',
  'instagramUsername',
  'instagramProfileLink',
  'email',
  'phoneNumber',
  'addressLine1',
  'addressLine2',
  'addressCity',
  'addressState',
  'addressPostalCode',
  'addressCountry',
  'campaignName',
  'outreachStage',
  'assignedManager',
  'averageViews',
  'averageLikes',
  'engagementRate',
  'followers',
  'riskLevel',
  'cpm',
  'acceptedRate',
  'quotedRate',
  'numberOfVideos',
  'numberOfStories',
  'numberOfReels',
  'guaranteedViews',
  'deadline',
  'deliverablesDescription',
  'threadId',
  'emailStatus',
] as const;

export interface MergePlan {
  survivorId: string;
  duplicateId: string;
  /** Fields that would be (or were) copied off the duplicate. */
  filledFields: { field: string; value: string | null }[];
  movedContracts: number;
  movedStats: number;
  /** Stats rows dropped because the survivor already has that campaign. */
  droppedStats: number;
  movedEmailHistory: number;
  movedActivityLogs: number;
}

export interface MergeResult extends MergePlan {
  dryRun: boolean;
  survivor: Creator | null;
}

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

const repr = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

/**
 * JSON for the audit trail. BigInt has no JSON representation and would throw
 * mid-transaction, taking the whole merge down over a logging detail — render it
 * as a string instead.
 */
const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

@Injectable()
export class CreatorMergeService {
  private readonly logger = new Logger(CreatorMergeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /**
   * Merge `duplicateId` into `survivorId`.
   *
   * Runs in its own transaction unless an outer one is supplied (the upsert path
   * merges mid-transaction, so the whole sync stays atomic).
   */
  async merge(
    survivorId: string,
    duplicateId: string,
    opts: { dryRun?: boolean; source?: ActivitySource } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<MergeResult> {
    if (survivorId === duplicateId) {
      throw new BadRequestException('survivorId and duplicateId must differ');
    }
    if (tx) return this.doMerge(tx, survivorId, duplicateId, opts);
    return this.prisma.$transaction((t) => this.doMerge(t, survivorId, duplicateId, opts));
  }

  private async doMerge(
    tx: Prisma.TransactionClient,
    survivorId: string,
    duplicateId: string,
    opts: { dryRun?: boolean; source?: ActivitySource },
  ): Promise<MergeResult> {
    const dryRun = opts.dryRun === true;
    const source = opts.source ?? ActivitySource.MANUAL_API;

    const [survivor, duplicate] = await Promise.all([
      tx.creator.findUnique({ where: { id: survivorId } }),
      tx.creator.findUnique({ where: { id: duplicateId } }),
    ]);
    if (!survivor) throw new NotFoundException(`Creator ${survivorId} not found`);
    if (!duplicate) throw new NotFoundException(`Creator ${duplicateId} not found`);

    // Work out which of the survivor's gaps the duplicate can fill.
    const updateData: Record<string, unknown> = {};
    const filledFields: MergePlan['filledFields'] = [];
    for (const field of FILLABLE_FIELDS) {
      const incoming = (duplicate as Record<string, unknown>)[field];
      if (isEmpty(incoming)) continue;
      if (!isEmpty((survivor as Record<string, unknown>)[field])) continue;
      updateData[field] = incoming;
      filledFields.push({ field, value: repr(incoming) });
    }

    // CreatorStats is unique on (creatorId, statsCampaignId), so a stats row for
    // a campaign the survivor already has cannot be re-pointed — the survivor's
    // own row is the one to keep.
    // Full rows, not just ids: the colliding ones get deleted, and the snapshot
    // written below is the only copy that survives.
    const [dupStats, survivorStats] = await Promise.all([
      tx.creatorStats.findMany({ where: { creatorId: duplicateId } }),
      tx.creatorStats.findMany({
        where: { creatorId: survivorId },
        select: { statsCampaignId: true },
      }),
    ]);
    const survivorCampaigns = new Set(survivorStats.map((s) => s.statsCampaignId));
    const statsToMove = dupStats.filter((s) => !survivorCampaigns.has(s.statsCampaignId));
    const statsToDrop = dupStats.filter((s) => survivorCampaigns.has(s.statsCampaignId));

    const [contractCount, emailCount, activityCount] = await Promise.all([
      tx.contract.count({ where: { creatorId: duplicateId } }),
      tx.emailHistory.count({ where: { creatorId: duplicateId } }),
      tx.activityLog.count({ where: { creatorId: duplicateId } }),
    ]);

    const plan: MergePlan = {
      survivorId,
      duplicateId,
      filledFields,
      movedContracts: contractCount,
      movedStats: statsToMove.length,
      droppedStats: statsToDrop.length,
      movedEmailHistory: emailCount,
      movedActivityLogs: activityCount,
    };

    if (dryRun) return { ...plan, dryRun: true, survivor };

    // Re-point every relation onto the survivor.
    await tx.contract.updateMany({
      where: { creatorId: duplicateId },
      data: { creatorId: survivorId },
    });
    if (statsToMove.length) {
      await tx.creatorStats.updateMany({
        where: { id: { in: statsToMove.map((s) => s.id) } },
        data: { creatorId: survivorId },
      });
    }
    if (statsToDrop.length) {
      await tx.creatorStats.deleteMany({ where: { id: { in: statsToDrop.map((s) => s.id) } } });
    }
    await tx.emailHistory.updateMany({
      where: { creatorId: duplicateId },
      data: { creatorId: survivorId },
    });
    await tx.activityLog.updateMany({
      where: { creatorId: duplicateId },
      data: { creatorId: survivorId },
    });

    // Delete BEFORE writing the filled identity keys: email and instagramUsername
    // are unique, so the duplicate has to release them first.
    await tx.creator.delete({ where: { id: duplicateId } });

    let updated = survivor;
    if (Object.keys(updateData).length) {
      updated = await tx.creator.update({ where: { id: survivorId }, data: updateData });
    }

    await this.activityLog.record(
      survivorId,
      [
        {
          field: 'merged',
          oldValue: this.label(duplicate),
          newValue: `absorbed duplicate ${duplicateId}`,
        },
        // A complete copy of everything this merge destroyed, so the operation
        // can be reconstructed by hand from the audit trail alone. Most of a
        // merge only re-points rows, but two things genuinely go away: the
        // duplicate row itself (including any field the survivor already had,
        // which is deliberately not copied over) and its stats for a campaign
        // the survivor also covers. Without a database backup this entry is the
        // only record of them.
        {
          field: 'merged_snapshot',
          oldValue: safeJson({ creator: duplicate, droppedStats: statsToDrop }),
          newValue: null,
        },
        ...filledFields.map((f) => ({ field: f.field, oldValue: null, newValue: f.value })),
      ],
      source,
      tx,
    );

    this.logger.log(
      `Merged creator ${duplicateId} into ${survivorId} ` +
        `(${plan.movedContracts} contract(s), ${plan.movedStats} stats, ` +
        `${filledFields.length} field(s) filled)`,
    );

    return { ...plan, dryRun: false, survivor: updated };
  }

  private label(c: Creator): string {
    return c.instagramUsername ?? c.email ?? c.creatorName ?? c.id;
  }
}
