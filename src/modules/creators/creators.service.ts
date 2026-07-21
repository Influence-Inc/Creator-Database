import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ActivitySource, Creator, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildPaginatedResponse, PaginatedResponse } from '../../common/dto/paginated-response.dto';
import {
  instagramProfileLink,
  normalizeCurrency,
  normalizeEmail,
  normalizeInstagram,
  normalizeName,
} from '../../common/utils/normalize';
import { ActivityChange } from '../activity-log/activity-change.interface';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreatorUpsertInput, FILL_ONLY_FIELDS, MERGEABLE_FIELDS } from './creator-fields.interface';
import { CreatorsRepository, CreatorWithContractCount } from './creators.repository';
import { CategorizeCreatorsDto } from './dto/categorize-creators.dto';
import { CategorizeResult } from './dto/categorize-result.interface';
import { CreateCreatorDto } from './dto/create-creator.dto';
import { ParticipationQueryDto } from './dto/participation-query.dto';
import { QueryCreatorsDto } from './dto/query-creators.dto';
import { UpdateCreatorDto } from './dto/update-creator.dto';

export interface UpsertResult {
  creator: Creator | null;
  created: boolean;
  changed: boolean;
  skipped: boolean;
}

/** One campaign a creator has been part of, with where we learned it from. */
export interface PriorCampaign {
  name: string;
  brandName: string | null;
  source: 'master' | 'contract' | 'stats';
  status: string | null;
}

/** Segmentation verdict for a single looked-up Instagram handle. */
export interface ParticipationResult {
  input: string;
  instagramUsername: string | null;
  found: boolean;
  hasPriorParticipation: boolean;
  priorCampaigns: PriorCampaign[];
  contact: { creatorName: string | null; email: string | null; phoneNumber: string | null } | null;
}

/** Compare two field values, treating Dates by timestamp. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : new Date(a as string).getTime();
    const bt = b instanceof Date ? b.getTime() : new Date(b as string).getTime();
    return at === bt;
  }
  return a === b;
}

/** Render a value for the activity log (ISO for dates, string otherwise). */
function repr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * Owns the master-record invariant: exactly one Creator row per real-world
 * creator, identified by email > instagram > name. Every source funnels through
 * `upsertFromSource`, which resolves the identity, merges only the fields the
 * source actually knows about, and records every change in the activity log.
 */
@Injectable()
export class CreatorsService {
  private readonly logger = new Logger(CreatorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: CreatorsRepository,
    private readonly activityLog: ActivityLogService,
  ) {}

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  async findMany(query: QueryCreatorsDto): Promise<PaginatedResponse<CreatorWithContractCount>> {
    const { data, total } = await this.repo.search(query);
    return buildPaginatedResponse(data, total, query.page, query.limit);
  }

  async findOne(id: string): Promise<Creator> {
    const creator = await this.repo.findById(id);
    if (!creator) throw new NotFoundException(`Creator ${id} not found`);
    return creator;
  }

  getActivity(id: string, limit = 100) {
    return this.activityLog.findByCreator(id, limit);
  }

  /**
   * New-vs-old segmentation for the Outreach Deal Studio. For each Instagram
   * handle, report whether that creator has already participated in a campaign
   * OTHER than the current one (`excludeCampaign`). Participation evidence is
   * gathered from the master record's campaign plus every contract and stats
   * snapshot (each names the campaign it belongs to). A creator with prior
   * participation is "old" (route them through the offer portal); everyone else
   * — unknown handles included — is "new".
   */
  async checkParticipation(dto: ParticipationQueryDto): Promise<{ results: ParticipationResult[] }> {
    const normalizedByInput = new Map<string, string | null>();
    for (const raw of dto.instagramUsernames) {
      if (!normalizedByInput.has(raw)) normalizedByInput.set(raw, normalizeInstagram(raw));
    }
    const handles = [
      ...new Set(
        [...normalizedByInput.values()].filter((h): h is string => typeof h === 'string' && h.length > 0),
      ),
    ];

    const rows = handles.length ? await this.repo.findManyByInstagramWithHistory(handles) : [];
    const byHandle = new Map(rows.map((r) => [r.instagramUsername as string, r]));

    const exclude = dto.excludeCampaign ? dto.excludeCampaign.trim().toLowerCase() : null;
    const isExcluded = (name: string | null | undefined): boolean =>
      exclude != null && !!name && name.trim().toLowerCase() === exclude;

    const results = dto.instagramUsernames.map((input): ParticipationResult => {
      const handle = normalizedByInput.get(input) ?? null;
      const row = handle ? byHandle.get(handle) : undefined;
      if (!row) {
        return {
          input,
          instagramUsername: handle,
          found: false,
          hasPriorParticipation: false,
          priorCampaigns: [],
          contact: null,
        };
      }

      // Collect distinct campaigns (by name), preferring the earliest source in
      // master > contract > stats order.
      const campaigns: PriorCampaign[] = [];
      const seen = new Set<string>();
      const add = (
        name: string | null | undefined,
        brandName: string | null | undefined,
        source: PriorCampaign['source'],
        status?: string | null,
      ): void => {
        if (!name) return;
        const key = name.trim().toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        campaigns.push({ name, brandName: brandName ?? null, source, status: status ?? null });
      };
      add(row.campaignName, null, 'master');
      for (const c of row.contracts) add(c.campaignName, c.brandName, 'contract', c.status);
      for (const s of row.stats) add(s.campaignName, s.brandName, 'stats');

      const priorCampaigns = campaigns.filter((c) => !isExcluded(c.name));

      return {
        input,
        instagramUsername: row.instagramUsername,
        found: true,
        hasPriorParticipation: priorCampaigns.length > 0,
        priorCampaigns,
        contact: {
          creatorName: row.creatorName,
          email: row.email,
          phoneNumber: row.phoneNumber,
        },
      };
    });

    return { results };
  }

  /**
   * Classify a batch of {email, instagramUsername} keys as used/unused/new.
   * Positional — the response is the same length and order as `dto.keys`. The
   * caller (Deal Studio) uses this to render the badge on its creators table
   * with one round-trip instead of N.
   *   • used   — creator exists AND has ≥1 contract row (any status)
   *   • unused — creator exists but has NO contract rows
   *   • new    — no creator matches the key
   *
   * Distinct from checkParticipation above: that one answers "have they been
   * in ANOTHER campaign", used to route returning creators through the offer
   * portal; this one answers "have they signed a contract with us", used for
   * the Deal Studio's Used/Unused/New badge.
   */
  async categorize(dto: CategorizeCreatorsDto): Promise<CategorizeResult[]> {
    // Normalize each key so a caller passing "Alex@Example.COM" or a full IG
    // URL still matches the stored (lower-cased, handle-only) master record.
    const normalized = dto.keys.map((k) => ({
      email: normalizeEmail(k.email),
      instagramUsername: normalizeInstagram(k.instagramUsername),
    }));

    // One query per unique identity — de-dup handled inside the repo.
    const matches = await this.repo.findByIdentityKeys(normalized);
    const byEmail = new Map<string, (typeof matches)[number]>();
    const byIg = new Map<string, (typeof matches)[number]>();
    for (const m of matches) {
      if (m.email) byEmail.set(m.email, m);
      if (m.instagramUsername) byIg.set(m.instagramUsername, m);
    }

    return normalized.map((key) => {
      const hit =
        (key.email && byEmail.get(key.email)) ||
        (key.instagramUsername && byIg.get(key.instagramUsername)) ||
        null;
      if (!hit) return { key, category: 'new', creator: null };
      const category = hit.contractsCount > 0 ? 'used' : 'unused';
      return {
        key,
        category,
        creator: {
          id: hit.id,
          creatorName: hit.creatorName,
          email: hit.email,
          instagramUsername: hit.instagramUsername,
          contractsCount: hit.contractsCount,
        },
      };
    });
  }

  /**
   * Hard-delete a creator. Cascades to its stats + contracts (onDelete: Cascade)
   * and nulls the creator on email_history / activity_logs (onDelete: SetNull).
   */
  async remove(id: string): Promise<{ deleted: true; id: string }> {
    try {
      await this.prisma.creator.delete({ where: { id } });
      this.logger.log(`Deleted creator ${id}`);
      return { deleted: true, id };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException(`Creator ${id} not found`);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Manual write API (source = MANUAL_API)
  // -------------------------------------------------------------------------

  /** Create-or-merge from the manual API. Requires at least one identity key. */
  async createManual(dto: CreateCreatorDto): Promise<Creator> {
    const input = this.dtoToInput(dto);
    const normalized = this.normalizeInput(input);
    if (!this.hasIdentity(normalized)) {
      throw new BadRequestException(
        'At least one identity field is required: email, instagramUsername, or creatorName',
      );
    }
    const result = await this.upsertFromSource(input, ActivitySource.MANUAL_API);
    if (!result.creator) {
      throw new BadRequestException('Unable to create creator from the provided fields');
    }
    return result.creator;
  }

  /** Update a specific creator by id (manual edits may overwrite identity). */
  async updateManual(id: string, dto: UpdateCreatorDto): Promise<Creator> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException(`Creator ${id} not found`);

    const input = this.normalizeInput(this.dtoToInput(dto));

    return this.prisma.$transaction(async (tx) => {
      const { updateData, changes } = this.buildMergeableChanges(existing, input);

      // Manual edits are allowed to overwrite identity keys directly.
      for (const field of FILL_ONLY_FIELDS) {
        const incoming = input[field];
        if (incoming === undefined || incoming === null) continue;
        if (!valuesEqual(existing[field], incoming)) {
          (updateData as Record<string, unknown>)[field] = incoming;
          changes.push({ field, oldValue: repr(existing[field]), newValue: repr(incoming) });
        }
      }

      if (changes.length === 0) return existing;

      const updated = await this.repo.update(id, updateData, tx);
      await this.activityLog.record(id, changes, ActivitySource.MANUAL_API, tx);
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Core upsert / merge (used by sync + manual)
  // -------------------------------------------------------------------------

  /**
   * Resolve the creator's identity and either create a new record or merge the
   * provided fields into the existing one. Retries once on a unique-constraint
   * race (two syncs creating the same creator concurrently).
   */
  async upsertFromSource(
    rawInput: CreatorUpsertInput,
    source: ActivitySource,
  ): Promise<UpsertResult> {
    const input = this.normalizeInput(rawInput);

    if (!this.hasIdentity(input)) {
      this.logger.debug('Skipping upsert: no identity fields present', { source });
      return { creator: null, created: false, changed: false, skipped: true };
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => this.doUpsert(tx, input, source));
      } catch (err) {
        // P2002 = a concurrent create won the race; retry resolves + merges.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          attempt < 2
        ) {
          this.logger.warn('Upsert hit a unique-constraint race; retrying as update', { source });
          continue;
        }
        throw err;
      }
    }

    // Unreachable in practice, but satisfies the type checker.
    return { creator: null, created: false, changed: false, skipped: false };
  }

  private async doUpsert(
    tx: Prisma.TransactionClient,
    input: CreatorUpsertInput,
    source: ActivitySource,
  ): Promise<UpsertResult> {
    const existing = await this.resolveExisting(input, tx);

    if (!existing) {
      const created = await this.repo.create(this.buildCreateData(input), tx);
      await this.activityLog.record(
        created.id,
        [{ field: 'created', oldValue: null, newValue: this.identityLabel(created) }],
        source,
        tx,
      );
      this.logger.debug(`Created creator ${created.id}`, { source });
      return { creator: created, created: true, changed: true, skipped: false };
    }

    const { updateData, changes } = this.buildMergeableChanges(existing, input);
    await this.applyIdentityFills(existing, input, updateData, changes, tx);

    if (changes.length === 0) {
      return { creator: existing, created: false, changed: false, skipped: false };
    }

    const updated = await this.repo.update(existing.id, updateData, tx);
    await this.activityLog.record(existing.id, changes, source, tx);
    this.logger.debug(`Updated creator ${existing.id} (${changes.length} field(s))`, { source });
    return { creator: updated, created: false, changed: true, skipped: false };
  }

  /** Resolve an existing creator by priority: email, then instagram, then name. */
  private async resolveExisting(
    input: CreatorUpsertInput,
    tx: Prisma.TransactionClient,
  ): Promise<Creator | null> {
    if (input.email) {
      const byEmail = await this.repo.findByEmail(input.email, tx);
      if (byEmail) return byEmail;
    }
    if (input.instagramUsername) {
      const byIg = await this.repo.findByInstagram(input.instagramUsername, tx);
      if (byIg) return byIg;
    }
    if (input.creatorName) {
      const byName = await this.repo.findByName(input.creatorName, tx);
      if (byName) return byName;
    }
    return null;
  }

  /** Compute the update payload + change log for non-identity fields. */
  private buildMergeableChanges(
    existing: Creator,
    input: CreatorUpsertInput,
  ): { updateData: Prisma.CreatorUncheckedUpdateInput; changes: ActivityChange[] } {
    const updateData: Prisma.CreatorUncheckedUpdateInput = {};
    const changes: ActivityChange[] = [];

    for (const field of MERGEABLE_FIELDS) {
      const incoming = input[field];
      if (incoming === undefined || incoming === null) continue;
      const current = (existing as Record<string, unknown>)[field];
      if (!valuesEqual(current, incoming)) {
        (updateData as Record<string, unknown>)[field] = incoming;
        changes.push({ field, oldValue: repr(current), newValue: repr(incoming) });
      }
    }

    return { updateData, changes };
  }

  /**
   * Fill empty identity keys (email, instagram) on an existing record, but only
   * when the value isn't already claimed by a *different* creator — pre-checking
   * avoids unique-constraint violations and never overwrites existing identity.
   */
  private async applyIdentityFills(
    existing: Creator,
    input: CreatorUpsertInput,
    updateData: Prisma.CreatorUncheckedUpdateInput,
    changes: ActivityChange[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (input.email && isEmpty(existing.email)) {
      const owner = await this.repo.findByEmail(input.email, tx);
      if (!owner || owner.id === existing.id) {
        updateData.email = input.email;
        changes.push({ field: 'email', oldValue: null, newValue: input.email });
      }
    }

    if (input.instagramUsername && isEmpty(existing.instagramUsername)) {
      const owner = await this.repo.findByInstagram(input.instagramUsername, tx);
      if (!owner || owner.id === existing.id) {
        updateData.instagramUsername = input.instagramUsername;
        changes.push({
          field: 'instagramUsername',
          oldValue: null,
          newValue: input.instagramUsername,
        });
        // Backfill the profile link if we just learned the handle.
        if (isEmpty(existing.instagramProfileLink) && input.instagramProfileLink === undefined) {
          const link = instagramProfileLink(input.instagramUsername);
          if (link) {
            updateData.instagramProfileLink = link;
            changes.push({ field: 'instagramProfileLink', oldValue: null, newValue: link });
          }
        }
      }
    }
  }

  /** Build the create payload for a brand-new creator from the input. */
  private buildCreateData(input: CreatorUpsertInput): Prisma.CreatorUncheckedCreateInput {
    const data: Prisma.CreatorUncheckedCreateInput = {};
    const assign = (key: keyof CreatorUpsertInput) => {
      const value = input[key];
      if (value !== undefined && value !== null) {
        (data as Record<string, unknown>)[key] = value;
      }
    };

    // Identity
    assign('email');
    assign('instagramUsername');
    assign('creatorName');
    assign('phoneNumber');

    // Derive the profile link from the handle if not supplied explicitly.
    if (input.instagramProfileLink) {
      data.instagramProfileLink = input.instagramProfileLink;
    } else if (input.instagramUsername) {
      const link = instagramProfileLink(input.instagramUsername);
      if (link) data.instagramProfileLink = link;
    }

    for (const field of MERGEABLE_FIELDS) {
      if (field === 'instagramProfileLink') continue; // handled above
      assign(field);
    }

    return data;
  }

  // -------------------------------------------------------------------------
  // Normalization + helpers
  // -------------------------------------------------------------------------

  /** Normalize identity + currency fields so matching is deterministic. */
  private normalizeInput(input: CreatorUpsertInput): CreatorUpsertInput {
    const out: CreatorUpsertInput = { ...input };

    if (input.email !== undefined) {
      out.email = input.email === null ? null : (normalizeEmail(input.email) ?? undefined);
    }
    if (input.instagramUsername !== undefined) {
      const handle =
        input.instagramUsername === null ? null : normalizeInstagram(input.instagramUsername);
      out.instagramUsername = handle ?? undefined;
    }
    if (input.creatorName !== undefined) {
      out.creatorName =
        input.creatorName === null ? null : (normalizeName(input.creatorName) ?? undefined);
    }
    if (input.currency !== undefined && input.currency !== null) {
      out.currency = normalizeCurrency(input.currency) ?? undefined;
    }
    // Note: we deliberately do NOT auto-derive instagramProfileLink here. The
    // profile link must follow the handle, so it's only set when we actually
    // adopt a handle (buildCreateData for new records, applyIdentityFills when
    // filling an empty handle) — never merged independently onto a record that
    // doesn't own that handle.

    return out;
  }

  private hasIdentity(input: CreatorUpsertInput): boolean {
    return Boolean(input.email || input.instagramUsername || input.creatorName);
  }

  private identityLabel(creator: Creator): string {
    return creator.email || creator.instagramUsername || creator.creatorName || creator.id;
  }

  /** Convert a validated DTO into the internal upsert input (parsing dates). */
  private dtoToInput(dto: CreateCreatorDto | UpdateCreatorDto): CreatorUpsertInput {
    const parseDate = (value?: string) => (value ? new Date(value) : undefined);
    return {
      creatorName: dto.creatorName,
      instagramUsername: dto.instagramUsername,
      instagramProfileLink: dto.instagramProfileLink,
      email: dto.email,
      phoneNumber: dto.phoneNumber,
      campaignName: dto.campaignName,
      campaignId: dto.campaignId,
      outreachStage: dto.outreachStage,
      assignedManager: dto.assignedManager,
      averageViews: dto.averageViews,
      averageLikes: dto.averageLikes,
      engagementRate: dto.engagementRate,
      followers: dto.followers,
      cpm: dto.cpm,
      acceptedRate: dto.acceptedRate,
      quotedRate: dto.quotedRate,
      currency: dto.currency,
      numberOfVideos: dto.numberOfVideos,
      numberOfStories: dto.numberOfStories,
      numberOfReels: dto.numberOfReels,
      guaranteedViews: dto.guaranteedViews,
      deadline: parseDate(dto.deadline),
      deliverablesDescription: dto.deliverablesDescription,
      latestEmailDate: parseDate(dto.latestEmailDate),
      lastReplyDate: parseDate(dto.lastReplyDate),
      threadId: dto.threadId,
      emailStatus: dto.emailStatus,
      inboxRate: dto.inboxRate,
      spamRate: dto.spamRate,
      bounced: dto.bounced,
      opened: dto.opened,
      replied: dto.replied,
      status: dto.status,
    };
  }
}
