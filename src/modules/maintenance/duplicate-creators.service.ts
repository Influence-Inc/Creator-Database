import { Injectable, Logger } from '@nestjs/common';
import { ActivitySource } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatorMergeService, MergeResult } from '../creators/creator-merge.service';

/**
 * Finds creator records that are the same person split across two rows.
 *
 * The split: a signed contract that arrived without an Instagram handle (see
 * CreatorMergeService) could not resolve against the master record, so it
 * created a second row holding the signer's email, phone, address and payout
 * details — and no handle.
 *
 * By construction the two rows share almost nothing. The master came from the
 * stats sync carrying a handle and performance but no email; the duplicate
 * carries an email and a contract but no handle. If they had a field in common
 * they would have resolved to one record in the first place. So this reports
 * two grades of match and treats them very differently:
 *
 *   high    Hard identity evidence — the same email or phone appears on both
 *           sides, via the creator row itself, a contract's signer details, or
 *           an address we actually sent outreach to. Safe to merge unattended.
 *
 *   review  The duplicate's name appears inside the master's handle ("Joe" in
 *           "aibyjoe", "AIMAN" in "aiman.gn"), optionally corroborated by a
 *           shared campaign. That is a strong hint and it is how these splits
 *           usually look, but a name is not proof of identity — a human
 *           confirms these one at a time via POST /maintenance/merge-creators.
 *
 * `mergeAll` only ever merges `high`. Nothing gets folded together on the
 * strength of a name resemblance without someone looking at it.
 */

export type MatchEvidence =
  | 'email' // same address on both sides (creator, signer, or outreach recipient)
  | 'phone' // same phone on both sides
  | 'threadId' // same outreach email thread
  | 'nameInHandle' // duplicate's name appears inside the master's handle
  | 'sharedCampaign'; // both sides reference the same campaign

export type Confidence = 'high' | 'review';

/** Evidence that stands on its own; anything else needs human review. */
const HARD_EVIDENCE: ReadonlySet<MatchEvidence> = new Set(['email', 'phone', 'threadId']);

export interface CreatorBrief {
  id: string;
  creatorName: string | null;
  instagramUsername: string | null;
  email: string | null;
  contracts: number;
}

export interface DuplicatePair {
  /** The record to keep — the master holding the Instagram handle. */
  survivor: CreatorBrief;
  /** The handle-less record holding the contact + payout details. */
  duplicate: CreatorBrief;
  evidence: MatchEvidence[];
  confidence: Confidence;
  /** Campaign names both sides reference, if any. */
  sharedCampaigns: string[];
  /** Other masters that also matched — present only when the match is unsure. */
  alternatives: CreatorBrief[];
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

/** Reduce a handle to comparable letters: "aiman.gn" → "aimangn". */
const flatten = (v: string | null | undefined): string =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Name parts worth matching on. Very short tokens ("jo", "li") and the generic
 * ones that show up in handles regardless of who owns them would match far too
 * much, so they are dropped.
 */
const STOPWORDS = new Set(['the', 'official', 'real', 'its', 'iam', 'mr', 'mrs', 'ms', 'dr']);
const nameTokens = (name: string | null | undefined): string[] =>
  String(name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

@Injectable()
export class DuplicateCreatorsService {
  private readonly logger = new Logger(DuplicateCreatorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly merger: CreatorMergeService,
  ) {}

  /**
   * Candidate pairs with the evidence and confidence for each, plus the
   * handle-less records nothing could be tied to. Read-only.
   */
  async find(): Promise<{
    pairs: DuplicatePair[];
    unmatched: CreatorBrief[];
    counts: { high: number; review: number; unmatched: number };
  }> {
    // Candidates: no handle, but holding identity or a contract to match on.
    const candidates = await this.prisma.creator.findMany({
      where: {
        instagramUsername: null,
        OR: [
          { email: { not: null } },
          { threadId: { not: null } },
          { phoneNumber: { not: null } },
          { contracts: { some: {} } },
        ],
      },
      select: {
        id: true,
        creatorName: true,
        instagramUsername: true,
        email: true,
        threadId: true,
        phoneNumber: true,
        campaignName: true,
        contracts: {
          select: {
            signerEmail: true,
            signerPhone: true,
            signerName: true,
            campaignName: true,
          },
        },
      },
    });
    if (candidates.length === 0) {
      return { pairs: [], unmatched: [], counts: { high: 0, review: 0, unmatched: 0 } };
    }

    const masters = await this.prisma.creator.findMany({
      where: { instagramUsername: { not: null } },
      select: {
        id: true,
        creatorName: true,
        instagramUsername: true,
        email: true,
        threadId: true,
        phoneNumber: true,
        campaignName: true,
        contracts: { select: { signerEmail: true, signerPhone: true, campaignName: true } },
        stats: { select: { campaignName: true } },
      },
    });
    if (masters.length === 0) {
      const unmatched = candidates.map((c) => this.brief(c));
      return {
        pairs: [],
        unmatched,
        counts: { high: 0, review: 0, unmatched: unmatched.length },
      };
    }

    // Outreach we actually sent, keyed by address. Bounded to the addresses we
    // care about — this table holds one row per message.
    const candidateEmails = [
      ...new Set(
        candidates
          .flatMap((c) => [norm(c.email), ...c.contracts.map((ct) => norm(ct.signerEmail))])
          .filter((e): e is string => e !== null),
      ),
    ];
    const recipientsByMaster = new Map<string, Set<string>>();
    if (candidateEmails.length) {
      const rows = await this.prisma.emailHistory.findMany({
        where: {
          creatorId: { in: masters.map((m) => m.id) },
          OR: candidateEmails.map((e) => ({
            recipient: { equals: e, mode: 'insensitive' as const },
          })),
        },
        select: { creatorId: true, recipient: true },
      });
      for (const r of rows) {
        const rcpt = norm(r.recipient);
        if (!rcpt || !r.creatorId) continue;
        if (!recipientsByMaster.has(r.creatorId)) recipientsByMaster.set(r.creatorId, new Set());
        recipientsByMaster.get(r.creatorId)!.add(rcpt);
      }
    }

    // Pre-compute each master's matchable identity once.
    const masterIndex = masters.map((m) => ({
      row: m,
      emails: new Set(
        [norm(m.email), ...m.contracts.map((c) => norm(c.signerEmail))]
          .concat([...(recipientsByMaster.get(m.id) ?? [])])
          .filter((e): e is string => e !== null),
      ),
      phones: new Set(
        [normPhone(m.phoneNumber), ...m.contracts.map((c) => normPhone(c.signerPhone))].filter(
          (p): p is string => p !== null,
        ),
      ),
      thread: norm(m.threadId),
      handle: flatten(m.instagramUsername),
      nameBlob: flatten(m.creatorName) + flatten(m.instagramUsername),
      campaigns: new Set(
        [
          norm(m.campaignName),
          ...m.contracts.map((c) => norm(c.campaignName)),
          ...m.stats.map((s) => norm(s.campaignName)),
        ].filter((c): c is string => c !== null),
      ),
    }));

    const pairs: DuplicatePair[] = [];
    const unmatched: CreatorBrief[] = [];

    for (const c of candidates) {
      const cEmails = new Set(
        [norm(c.email), ...c.contracts.map((ct) => norm(ct.signerEmail))].filter(
          (e): e is string => e !== null,
        ),
      );
      const cPhones = new Set(
        [normPhone(c.phoneNumber), ...c.contracts.map((ct) => normPhone(ct.signerPhone))].filter(
          (p): p is string => p !== null,
        ),
      );
      const cThread = norm(c.threadId);
      const cCampaigns = new Set(
        [norm(c.campaignName), ...c.contracts.map((ct) => norm(ct.campaignName))].filter(
          (x): x is string => x !== null,
        ),
      );
      // Names to look for inside the handle — the creator's own name plus
      // whatever they typed on the signing form.
      const cTokens = [
        ...new Set([
          ...nameTokens(c.creatorName),
          ...c.contracts.flatMap((ct) => nameTokens(ct.signerName)),
        ]),
      ];

      const scored: { master: (typeof masterIndex)[number]; evidence: Set<MatchEvidence> }[] = [];
      for (const m of masterIndex) {
        if (m.row.id === c.id) continue;
        const evidence = new Set<MatchEvidence>();

        for (const e of cEmails) if (m.emails.has(e)) evidence.add('email');
        for (const p of cPhones) if (m.phones.has(p)) evidence.add('phone');
        if (cThread && m.thread === cThread) evidence.add('threadId');
        // The name sitting inside the handle: "joe" within "aibyjoe".
        if (m.handle && cTokens.some((t) => m.nameBlob.includes(t))) evidence.add('nameInHandle');
        for (const camp of cCampaigns) if (m.campaigns.has(camp)) evidence.add('sharedCampaign');

        // A shared campaign on its own says nothing — dozens of creators run the
        // same campaign. It only counts as corroboration alongside another signal.
        const meaningful = [...evidence].filter((e) => e !== 'sharedCampaign');
        if (meaningful.length > 0) scored.push({ master: m, evidence });
      }

      if (scored.length === 0) {
        unmatched.push(this.brief(c));
        continue;
      }

      // Hard evidence wins outright; otherwise fall back to the name match.
      const hard = scored.filter((s) => [...s.evidence].some((e) => HARD_EVIDENCE.has(e)));
      const pool = hard.length > 0 ? hard : scored;
      const confidence: Confidence = hard.length > 0 ? 'high' : 'review';

      // More than one master fits: never auto-merge, and show the alternatives.
      if (pool.length > 1) {
        const ranked = pool
          .slice()
          .sort((a, b) => b.evidence.size - a.evidence.size)
          .map((s) => s.master);
        pairs.push({
          survivor: this.brief(ranked[0].row),
          duplicate: this.brief(c),
          evidence: [...pool[0].evidence],
          confidence: 'review',
          sharedCampaigns: [...cCampaigns].filter((x) => ranked[0].campaigns.has(x)),
          alternatives: ranked.slice(1).map((m) => this.brief(m.row)),
        });
        continue;
      }

      const best = pool[0];
      pairs.push({
        survivor: this.brief(best.master.row),
        duplicate: this.brief(c),
        evidence: [...best.evidence],
        confidence,
        sharedCampaigns: [...cCampaigns].filter((x) => best.master.campaigns.has(x)),
        alternatives: [],
      });
    }

    // Surest first, so the reviewer works down a sensible list.
    pairs.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1));

    return {
      pairs,
      unmatched,
      counts: {
        high: pairs.filter((p) => p.confidence === 'high').length,
        review: pairs.filter((p) => p.confidence === 'review').length,
        unmatched: unmatched.length,
      },
    };
  }

  /**
   * Merge the `high`-confidence pairs — those backed by a matching email, phone
   * or outreach thread. `review` pairs are deliberately left alone: a name
   * inside a handle is a good hint, not proof, and merging is destructive.
   *
   * `dryRun` reports the plan without writing. Each pair merges in its own
   * transaction, so one failure cannot roll back the pairs that succeeded.
   */
  async mergeAll(dryRun = false): Promise<{
    dryRun: boolean;
    matched: number;
    merged: number;
    failed: number;
    needsReview: number;
    unmatched: number;
    results: (MergeResult & { evidence: MatchEvidence[] })[];
    errors: { duplicateId: string; error: string }[];
  }> {
    const { pairs, counts } = await this.find();
    const auto = pairs.filter((p) => p.confidence === 'high');
    const results: (MergeResult & { evidence: MatchEvidence[] })[] = [];
    const errors: { duplicateId: string; error: string }[] = [];

    for (const pair of auto) {
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
      matched: auto.length,
      merged: dryRun ? 0 : results.length,
      failed: errors.length,
      needsReview: counts.review,
      unmatched: counts.unmatched,
      results,
      errors,
    };
  }

  private brief(c: {
    id: string;
    creatorName: string | null;
    instagramUsername: string | null;
    email: string | null;
    contracts?: unknown[];
  }): CreatorBrief {
    return {
      id: c.id,
      creatorName: c.creatorName,
      instagramUsername: c.instagramUsername,
      email: c.email,
      contracts: Array.isArray(c.contracts) ? c.contracts.length : 0,
    };
  }
}
