import { Injectable, Logger } from '@nestjs/common';
import { ActivitySource } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatorMergeService, MergeResult } from '../creators/creator-merge.service';

/**
 * Finds creator records that are the same person split across two rows, and
 * folds them back together.
 *
 * The split: a signed contract that arrived without an Instagram handle (see
 * CreatorMergeService for the window in which the Outreach backend omitted it)
 * could not resolve against the master record, so it created a second row
 * holding the signer's email, phone, address and payout details — and no handle.
 *
 * Re-syncing those contracts now heals them automatically, because the payload
 * carries both keys and CreatorsService.resolveExisting merges on an identity
 * split. This service covers the rest: pairs where no re-sync is coming, and
 * giving the team a reviewable list before anything is written.
 *
 * Matching is evidence-based, never fuzzy on names alone. A handle-less record
 * is only paired with a master when one of these ties them together:
 *
 *   - `email`     the master was emailed at exactly the duplicate's address
 *                 (EmailHistory.recipient), which is how outreach reached them;
 *   - `threadId`  both rows reference the same outreach email thread;
 *   - `phone`     both rows carry the same phone number.
 *
 * "Two creators are called Joe" is NOT evidence and will never produce a pair.
 */

export type MatchEvidence = 'email' | 'threadId' | 'phone';

export interface DuplicatePair {
  /** The record to keep — the master holding the Instagram handle. */
  survivor: { id: string; creatorName: string | null; instagramUsername: string | null };
  /** The handle-less record holding the contact + payout details. */
  duplicate: {
    id: string;
    creatorName: string | null;
    email: string | null;
    contracts: number;
  };
  evidence: MatchEvidence[];
}

const norm = (v: string | null | undefined): string | null => {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  return s === '' ? null : s;
};

/** Strip formatting so "+1 555 123 4567" and "15551234567" compare equal. */
const normPhone = (v: string | null | undefined): string | null => {
  const digits = String(v ?? '').replace(/\D/g, '');
  // Too short to be a real number — refuse to match on it.
  return digits.length >= 7 ? digits : null;
};

@Injectable()
export class DuplicateCreatorsService {
  private readonly logger = new Logger(DuplicateCreatorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly merger: CreatorMergeService,
  ) {}

  /**
   * Candidate duplicate pairs, each with the evidence that linked them.
   * Read-only — nothing is written.
   */
  async find(): Promise<{ pairs: DuplicatePair[]; unmatched: DuplicatePair['duplicate'][] }> {
    // Candidates: no handle, but they hold identity we could match on. A record
    // with neither an email, thread nor phone has nothing to tie it to a master.
    const candidates = await this.prisma.creator.findMany({
      where: {
        instagramUsername: null,
        OR: [{ email: { not: null } }, { threadId: { not: null } }, { phoneNumber: { not: null } }],
      },
      select: {
        id: true,
        creatorName: true,
        email: true,
        threadId: true,
        phoneNumber: true,
        _count: { select: { contracts: true } },
      },
    });
    if (candidates.length === 0) return { pairs: [], unmatched: [] };

    // Every possible survivor: a record that HAS a handle.
    const masters = await this.prisma.creator.findMany({
      where: { instagramUsername: { not: null } },
      select: {
        id: true,
        creatorName: true,
        instagramUsername: true,
        threadId: true,
        phoneNumber: true,
      },
    });
    if (masters.length === 0) {
      return { pairs: [], unmatched: candidates.map((c) => this.asDuplicate(c)) };
    }

    const masterIds = masters.map((m) => m.id);
    const byThread = new Map<string, string>();
    const byPhone = new Map<string, string>();
    for (const m of masters) {
      const t = norm(m.threadId);
      if (t && !byThread.has(t)) byThread.set(t, m.id);
      const p = normPhone(m.phoneNumber);
      if (p && !byPhone.has(p)) byPhone.set(p, m.id);
    }

    // Which master was emailed at which address. This is the strongest link:
    // outreach went to the address the creator later signed with.
    const candidateEmails = candidates
      .map((c) => norm(c.email))
      .filter((e): e is string => e !== null);
    const byRecipient = new Map<string, string>();
    const ambiguousRecipients = new Set<string>();
    if (candidateEmails.length) {
      const rows = await this.prisma.emailHistory.findMany({
        where: {
          creatorId: { in: masterIds },
          // Filter in SQL rather than pulling every email ever sent: this table
          // holds one row per message, so an unfiltered scan is unbounded.
          OR: candidateEmails.map((e) => ({
            recipient: { equals: e, mode: 'insensitive' as const },
          })),
        },
        select: { creatorId: true, recipient: true },
      });
      const wanted = new Set(candidateEmails);
      for (const r of rows) {
        const rcpt = norm(r.recipient);
        if (!rcpt || !r.creatorId || !wanted.has(rcpt)) continue;
        const seen = byRecipient.get(rcpt);
        if (seen && seen !== r.creatorId) {
          // Two masters were both emailed at this address — a shared or agency
          // inbox. Not evidence of anything; drop it and rely on the other
          // signals rather than guessing which creator it belongs to.
          ambiguousRecipients.add(rcpt);
          continue;
        }
        if (!seen) byRecipient.set(rcpt, r.creatorId);
      }
      for (const rcpt of ambiguousRecipients) byRecipient.delete(rcpt);
    }

    const masterById = new Map(masters.map((m) => [m.id, m]));
    const pairs: DuplicatePair[] = [];
    const unmatched: DuplicatePair['duplicate'][] = [];

    for (const c of candidates) {
      const hits = new Map<string, Set<MatchEvidence>>();
      const add = (id: string | undefined, ev: MatchEvidence) => {
        if (!id || id === c.id) return;
        if (!hits.has(id)) hits.set(id, new Set());
        hits.get(id)!.add(ev);
      };
      const email = norm(c.email);
      if (email) add(byRecipient.get(email), 'email');
      const thread = norm(c.threadId);
      if (thread) add(byThread.get(thread), 'threadId');
      const phone = normPhone(c.phoneNumber);
      if (phone) add(byPhone.get(phone), 'phone');

      // Ambiguous (two different masters matched) → leave it for a human.
      if (hits.size !== 1) {
        unmatched.push(this.asDuplicate(c));
        continue;
      }
      const [survivorId, evidence] = [...hits.entries()][0];
      const master = masterById.get(survivorId)!;
      pairs.push({
        survivor: {
          id: master.id,
          creatorName: master.creatorName,
          instagramUsername: master.instagramUsername,
        },
        duplicate: this.asDuplicate(c),
        evidence: [...evidence],
      });
    }

    return { pairs, unmatched };
  }

  /**
   * Merge every confidently-matched pair. `dryRun` reports the plan without
   * writing. Each pair merges in its own transaction, so one failure cannot
   * roll back the pairs that already succeeded.
   */
  async mergeAll(dryRun = false): Promise<{
    dryRun: boolean;
    matched: number;
    merged: number;
    failed: number;
    unmatched: number;
    results: (MergeResult & { evidence: MatchEvidence[] })[];
    errors: { duplicateId: string; error: string }[];
  }> {
    const { pairs, unmatched } = await this.find();
    const results: (MergeResult & { evidence: MatchEvidence[] })[] = [];
    const errors: { duplicateId: string; error: string }[] = [];

    for (const pair of pairs) {
      try {
        const res = await this.merger.merge(pair.survivor.id, pair.duplicate.id, {
          dryRun,
          source: ActivitySource.MANUAL_API,
        });
        results.push({ ...res, evidence: pair.evidence });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Merge failed for duplicate ${pair.duplicate.id}: ${message}`);
        errors.push({ duplicateId: pair.duplicate.id, error: message });
      }
    }

    return {
      dryRun,
      matched: pairs.length,
      merged: dryRun ? 0 : results.length,
      failed: errors.length,
      unmatched: unmatched.length,
      results,
      errors,
    };
  }

  private asDuplicate(c: {
    id: string;
    creatorName: string | null;
    email: string | null;
    _count: { contracts: number };
  }): DuplicatePair['duplicate'] {
    return {
      id: c.id,
      creatorName: c.creatorName,
      email: c.email,
      contracts: c._count.contracts,
    };
  }
}
