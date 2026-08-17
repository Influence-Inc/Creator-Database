import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Contract, Creator, CreatorStats, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { normalizePhoneNumber } from '../../common/utils/normalize';
import { UpdateDetailsDto } from './dto/update-details.dto';

/**
 * Read-model that powers the admin Creator Database UI (served from /public).
 *
 * It composes the master `Creator` record with its influence-stats snapshots
 * (`creator_stats`) and signed `contracts` into the exact shapes the roster and
 * profile screens render — so the browser makes one call per screen instead of
 * fanning out across three endpoints and doing joins client-side.
 *
 * Payout details (account number / IBAN / tax identifiers) are returned in full
 * on the profile — the console renders them directly rather than behind a
 * "Reveal" step — under the same guard that already protects
 * `GET /roster/:id/contracts`. The signature image stays out of the profile
 * payload; it is only served by that contracts endpoint.
 */
@Injectable()
export class RosterService {
  constructor(private readonly prisma: PrismaService) {}

  private static readonly PLATFORM_NAME: Record<string, string> = {
    IG: 'Instagram',
    TT: 'TikTok',
    YT: 'YouTube',
    instagram: 'Instagram',
    tiktok: 'TikTok',
    youtube: 'YouTube',
  };
  private static readonly PLATFORM_CODE: Record<string, string> = {
    instagram: 'IG',
    tiktok: 'TT',
    youtube: 'YT',
  };

  private normalizeRisk(risk: string | null): 'Low' | 'Med' | 'High' | null {
    if (!risk) return null;
    const r = risk.trim().toLowerCase();
    if (r.startsWith('low')) return 'Low';
    if (r.startsWith('med')) return 'Med';
    if (r.startsWith('high')) return 'High';
    return null;
  }

  /** engagementRate is stored as a fraction (0.048) — surface it as a percent. */
  private engagementPct(rate: number | null): number | null {
    if (rate === null || rate === undefined) return null;
    const pct = rate <= 1 ? rate * 100 : rate;
    return Math.round(pct * 10) / 10;
  }

  /** Split a stored "IG, TT" platforms string into codes. */
  private platformCodes(platforms: string | null): string[] {
    if (!platforms) return [];
    return platforms
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .filter((p) => p === 'IG' || p === 'TT' || p === 'YT');
  }

  /** Friendly platform label from a stored "IG, TT" string, e.g. "Instagram · TikTok". */
  private platformLabel(platforms: string | null): string | null {
    const codes = this.platformCodes(platforms);
    if (!codes.length) return null;
    return codes.map((c) => RosterService.PLATFORM_NAME[c] ?? c).join(' · ');
  }

  private initials(name: string): string {
    return name
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  private displayName(c: Creator, signerName?: string | null): string {
    return signerName || c.creatorName || c.instagramUsername || c.email || 'Unknown creator';
  }

  private handle(c: Creator): string {
    return c.instagramUsername ? `@${c.instagramUsername}` : '—';
  }

  private contractStatusLabel(status: string): 'Active' | 'Completed' | 'Pending' {
    if (status === 'COMPLETED') return 'Completed';
    if (status === 'SIGNED') return 'Active';
    return 'Pending';
  }

  // -------------------------------------------------------------------------
  // Roster (list screen)
  // -------------------------------------------------------------------------

  async roster(): Promise<{ creators: unknown[]; total: number }> {
    const creators = await this.prisma.creator.findMany({
      take: 1000,
      orderBy: { updatedAt: 'desc' },
    });
    const ids = creators.map((c) => c.id);

    const [stats, contracts] = await Promise.all([
      ids.length
        ? this.prisma.creatorStats.findMany({
            where: { creatorId: { in: ids } },
            select: { creatorId: true, platforms: true, totalViews: true, campaignName: true },
          })
        : Promise.resolve([]),
      ids.length
        ? this.prisma.contract.findMany({
            where: { creatorId: { in: ids } },
            select: {
              creatorId: true,
              status: true,
              campaignName: true,
              signerName: true,
              signatureImage: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
    ]);

    // Index the joined rows by creator so the mapping stays O(n).
    const statsByCreator = new Map<string, { platforms: Set<string>; views: number; count: number }>();
    for (const s of stats) {
      const e = statsByCreator.get(s.creatorId) ?? { platforms: new Set(), views: 0, count: 0 };
      for (const code of this.platformCodes(s.platforms)) e.platforms.add(code);
      e.views += s.totalViews ?? 0;
      e.count += 1;
      statsByCreator.set(s.creatorId, e);
    }

    // Track signed contracts per creator. A creator is "Used" when we've worked
    // with them — either they've signed a contract (status SIGNED or COMPLETED)
    // OR we already hold their campaign performance from influence-stats (they
    // ran campaigns with us before their contracts landed in this DB). Only
    // creators with no contract AND no performance history are "Unused".
    const contractsByCreator = new Map<
      string,
      { active: number; signed: number; signature: boolean; lastCampaign: string | null; signerName: string | null }
    >();
    for (const ct of contracts) {
      const e =
        contractsByCreator.get(ct.creatorId) ?? {
          active: 0,
          signed: 0,
          signature: false,
          lastCampaign: null,
          signerName: null,
        };
      if (ct.status === 'SIGNED') e.active += 1;
      if (ct.status === 'SIGNED' || ct.status === 'COMPLETED') e.signed += 1;
      if (ct.signatureImage) e.signature = true;
      if (!e.lastCampaign && ct.campaignName) e.lastCampaign = ct.campaignName; // rows are newest-first
      if (!e.signerName && ct.signerName) e.signerName = ct.signerName;
      contractsByCreator.set(ct.creatorId, e);
    }

    const order = ['IG', 'TT', 'YT'];
    const mapped = creators.map((c) => {
      const st = statsByCreator.get(c.id);
      const ct = contractsByCreator.get(c.id);
      const platforms = st ? order.filter((code) => st.platforms.has(code)) : [];
      const name = this.displayName(c, ct?.signerName);
      const signedContracts = ct?.signed ?? 0;
      const campaignsRun = st?.count ?? 0;
      return {
        id: c.id,
        name,
        handle: this.handle(c),
        initials: this.initials(name),
        platforms,
        campaigns: campaignsRun,
        signedContracts,
        // Used if they've signed a contract OR we have their campaign
        // performance on record; otherwise Unused.
        segment: signedContracts >= 1 || campaignsRun >= 1 ? 'used' : 'unused',
        views: st?.views ?? c.averageViews ?? 0,
        cpm: c.cpm,
        engagement: this.engagementPct(c.engagementRate),
        risk: this.normalizeRisk(c.riskLevel),
        followers: c.followers,
        signature: ct?.signature ?? false,
        activeContracts: ct?.active ?? 0,
        lastCampaign: ct?.lastCampaign ?? null,
      };
    });

    return { creators: mapped, total: mapped.length };
  }

  // -------------------------------------------------------------------------
  // Profile (detail screen)
  // -------------------------------------------------------------------------

  async profile(id: string): Promise<unknown> {
    const creator = await this.prisma.creator.findUnique({ where: { id } });
    if (!creator) throw new NotFoundException(`Creator ${id} not found`);

    const [stats, contracts] = await Promise.all([
      this.prisma.creatorStats.findMany({ where: { creatorId: id }, orderBy: { syncedAt: 'desc' } }),
      this.prisma.contract.findMany({ where: { creatorId: id }, orderBy: { createdAt: 'desc' } }),
    ]);

    const combinedViews =
      stats.reduce((sum, s) => sum + (s.totalViews ?? 0), 0) || creator.averageViews || 0;
    const latestContract = contracts[0];
    const latestStats = stats[0];

    // Every campaign the creator has run — merged from contracts + influence-stats.
    const campaignList = this.buildCampaignList(contracts, stats);

    return {
      id: creator.id,
      name: this.displayName(creator, contracts.find((c) => c.signerName)?.signerName),
      handle: this.handle(creator),
      initials: this.initials(this.displayName(creator, contracts.find((c) => c.signerName)?.signerName)),
      risk: this.normalizeRisk(creator.riskLevel),
      followers: creator.followers,
      views: combinedViews,
      cpm: creator.cpm,
      engagement: this.engagementPct(creator.engagementRate),
      campaigns: campaignList.length,
      // Unified campaign list (contracts + stats) shown in the Campaigns tab.
      campaignList,

      contact: this.buildContact(creator, contracts),
      payment: this.buildPayment(creator, contracts),
      usageRights: this.buildUsageRights(latestContract, latestStats),
      deliverables: this.buildDeliverables(contracts),
      contracts: contracts.map((ct) => ({
        campaign: ct.campaignName ?? '—',
        brand: ct.brandName ?? '—',
        start: ct.createdAt.toISOString(),
        end: ct.deadline ? ct.deadline.toISOString() : null,
        value: ct.compensation,
        currency: ct.currency ?? 'USD',
        status: this.contractStatusLabel(ct.status),
        // Per-campaign deliverables + rights (shown as columns in the UI).
        deliverables: ct.deliverables ?? null,
        platform: ct.platform ?? null,
        numberOfDeliverables: ct.numberOfDeliverables ?? null,
        usageRights: ct.usageRights ?? null,
        exclusivity: ct.exclusivity ?? null,
        deadline: ct.deadline ? ct.deadline.toISOString() : null,
      })),
      platformBreakdown: this.buildPlatformBreakdown(stats, combinedViews),
    };
  }

  /**
   * Admin edit of a creator's contact + identity + payout details.
   *
   * Contact & identity fields (creatorName, instagramUsername, email, phone,
   * address) always save directly to the master Creator record — a creator
   * doesn't need a signed contract before we can track their name / handle /
   * address. If a signed contract exists, the phone + address are mirrored
   * onto the LATEST contract too (so payment-of-record documents stay in sync).
   *
   * Payout details (bank / IBAN / tax IDs) are the same story: the master
   * Creator record is the source of truth (so a creator without any signed
   * contract can still have payout details on file), and when a signed contract
   * exists we mirror the merged JSON onto the LATEST contract's paymentDetails
   * so the payment-of-record documents keep matching.
   */
  async updateDetails(id: string, dto: UpdateDetailsDto): Promise<unknown> {
    const creator = await this.prisma.creator.findUnique({ where: { id } });
    if (!creator) throw new NotFoundException(`Creator ${id} not found`);

    const contact = dto.contact ?? {};
    const payment = dto.payment ?? {};

    // Merged payout JSON — computed once, written to Creator first and then
    // mirrored onto the latest contract if one exists. `''` clears a key.
    let mergedPayment: Record<string, unknown> | null = null;
    if (Object.keys(payment).length > 0) {
      const existing = (creator.paymentDetails as Record<string, unknown> | null) ?? {};
      const merged: Record<string, unknown> = { ...existing };
      for (const [k, v] of Object.entries(payment)) merged[k] = v === '' ? undefined : v;
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
      mergedPayment = merged;
    }

    // 1. Master Creator: identity + all contact fields (email/phone/address).
    //    Empty string clears the field; undefined leaves it untouched.
    // null is a valid "clear this field" signal from the DTO — EditContactDto's
    // @Transform turns '' → null for the email field so a cleared input can
    // actually clear the value (@IsEmail rejects '' before validation would
    // otherwise ever hit the service). Treat null the same as an already-empty
    // trimmed string: persist as null.
    const norm = (v: string | null | undefined) =>
      v === undefined ? undefined : v === null ? null : v.trim() || null;
    const creatorData: Prisma.CreatorUncheckedUpdateInput = {};
    if (contact.creatorName !== undefined) creatorData.creatorName = norm(contact.creatorName);
    if (contact.instagramUsername !== undefined) {
      const raw = norm(contact.instagramUsername);
      creatorData.instagramUsername = raw ? raw.replace(/^@+/, '').toLowerCase() : null;
    }
    if (contact.email !== undefined) creatorData.email = norm(contact.email);
    if (contact.phone !== undefined) {
      const trimmed = norm(contact.phone);
      creatorData.phoneNumber = trimmed ? normalizePhoneNumber(trimmed) : trimmed;
    }
    if (contact.address !== undefined) {
      const a = contact.address;
      creatorData.addressLine1 = norm(a.line1);
      creatorData.addressLine2 = norm(a.line2);
      creatorData.addressCity = norm(a.city);
      creatorData.addressState = norm(a.state);
      creatorData.addressPostalCode = norm(a.postalCode);
      creatorData.addressCountry = norm(a.country);
    }
    if (mergedPayment) {
      creatorData.paymentDetails = mergedPayment as Prisma.InputJsonValue;
    }
    if (Object.keys(creatorData).length) {
      try {
        await this.prisma.creator.update({ where: { id }, data: creatorData });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw await this.describeUniqueConflict(id, creatorData);
        }
        throw err;
      }
    }

    // 2. If a contract exists, mirror phone + address + payout details onto the
    //    LATEST contract so the payment-of-record stays in sync. Optional — a
    //    creator with no contract is perfectly valid to have contact / identity
    //    AND payout details on file (they live on the Creator record above).
    const latest = await this.prisma.contract.findFirst({
      where: { creatorId: id },
      orderBy: { createdAt: 'desc' },
    });

    if (latest) {
      const contractData: Prisma.ContractUncheckedUpdateInput = {};
      if (contact.phone !== undefined) {
        const trimmed = norm(contact.phone);
        contractData.signerPhone = trimmed ? normalizePhoneNumber(trimmed) : trimmed;
      }
      if (contact.address !== undefined) {
        const a = contact.address;
        contractData.addressLine1 = norm(a.line1);
        contractData.addressLine2 = norm(a.line2);
        contractData.addressCity = norm(a.city);
        contractData.addressState = norm(a.state);
        contractData.addressPostalCode = norm(a.postalCode);
        contractData.addressCountry = norm(a.country);
      }
      if (mergedPayment) {
        // Merge into the contract's own existing paymentDetails (which may hold
        // fields the Creator record hasn't seen yet — old signed-form entries),
        // then layer the freshly-edited keys on top.
        const contractExisting = (latest.paymentDetails as Record<string, unknown> | null) ?? {};
        const contractMerged: Record<string, unknown> = { ...contractExisting };
        for (const [k, v] of Object.entries(payment)) contractMerged[k] = v === '' ? undefined : v;
        for (const k of Object.keys(contractMerged)) {
          if (contractMerged[k] === undefined) delete contractMerged[k];
        }
        contractData.paymentDetails = contractMerged as Prisma.InputJsonValue;
      }
      if (Object.keys(contractData).length) {
        await this.prisma.contract.update({ where: { id: latest.id }, data: contractData });
      }
    }

    return this.profile(id);
  }

  /**
   * Turn a P2002 (unique-constraint) failure from the Creator update into a
   * message that names the EXACT field that collided and the creator that
   * already holds the value — instead of the ambiguous "email or Instagram
   * handle" that leaves an admin guessing (and blaming the field they just
   * changed when the real clash is on a field they didn't touch). Both `email`
   * and `instagramUsername` are @unique, and the edit form historically
   * re-sent both on every save, so the clash is often on the UNCHANGED field.
   */
  private async describeUniqueConflict(
    id: string,
    creatorData: Prisma.CreatorUncheckedUpdateInput,
  ): Promise<BadRequestException> {
    const label = (c: {
      creatorName: string | null;
      instagramUsername: string | null;
      email: string | null;
    }) => c.creatorName || (c.instagramUsername ? `@${c.instagramUsername}` : null) || c.email || 'another creator';

    const parts: string[] = [];

    const email = typeof creatorData.email === 'string' ? creatorData.email : null;
    if (email) {
      const owner = await this.prisma.creator.findFirst({
        where: { email, id: { not: id } },
        select: { creatorName: true, instagramUsername: true, email: true },
      });
      if (owner) parts.push(`the email ${email} is already used by ${label(owner)}`);
    }

    const ig = typeof creatorData.instagramUsername === 'string' ? creatorData.instagramUsername : null;
    if (ig) {
      const owner = await this.prisma.creator.findFirst({
        where: { instagramUsername: ig, id: { not: id } },
        select: { creatorName: true, instagramUsername: true, email: true },
      });
      if (owner) parts.push(`the Instagram handle @${ig} is already used by ${label(owner)}`);
    }

    if (parts.length) {
      return new BadRequestException(`Can't save — ${parts.join('; and ')}.`);
    }
    // P2002 fired but we couldn't pin the row (race, or a different unique
    // field). Keep the generic message rather than claim a specific field.
    return new BadRequestException(
      'That email or Instagram handle is already assigned to another creator',
    );
  }

  /**
   * Full signed contracts for a creator — every contract's own payout snapshot
   * and the signature image. This is the payment-processing / contract-review
   * view: profile() already carries the creator's current payout details, but
   * only this endpoint returns the per-contract history and the signature.
   */
  async contractsFull(creatorId: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { id: creatorId },
      select: {
        id: true,
        creatorName: true,
        instagramUsername: true,
        paymentDetails: true,
      },
    });
    if (!creator) throw new NotFoundException(`Creator ${creatorId} not found`);

    const contracts = await this.prisma.contract.findMany({
      where: { creatorId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      creatorId: creator.id,
      creatorName: contracts.find((c) => c.signerName)?.signerName ?? creator.creatorName ?? creator.instagramUsername ?? null,
      // Creator-level unredacted payout details — the source of truth used to
      // seed the Payment account edit form even when no contract exists yet.
      payment: (creator.paymentDetails as Record<string, unknown> | null) ?? null,
      contracts: contracts.map((c) => ({
        id: c.id,
        contractRef: c.contractRef,
        contractUrl: c.contractUrl,
        status: this.contractStatusLabel(c.status),
        // Campaign + deliverables
        brandName: c.brandName,
        campaignName: c.campaignName,
        platform: c.platform,
        deliverables: c.deliverables,
        numberOfDeliverables: c.numberOfDeliverables,
        timeline: c.timeline,
        deadline: c.deadline ? c.deadline.toISOString() : null,
        usageRights: c.usageRights,
        exclusivity: c.exclusivity,
        guaranteedViews: c.guaranteedViews,
        // Commercial
        compensation: c.compensation,
        currency: c.currency ?? 'USD',
        paymentTerms: c.paymentTerms,
        specialNotes: c.specialNotes,
        additionalTerms: c.additionalTerms,
        // Signer + identity
        signerName: c.signerName,
        signerEmail: c.signerEmail,
        signerPhone: c.signerPhone,
        signerGender: c.signerGender,
        signerSignedDate: c.signerSignedDate ? c.signerSignedDate.toISOString() : null,
        signedAt: c.signedAt ? c.signedAt.toISOString() : null,
        address: {
          line1: c.addressLine1,
          line2: c.addressLine2,
          city: c.addressCity,
          state: c.addressState,
          postalCode: c.addressPostalCode,
          country: c.addressCountry,
        },
        // Full payout details (unredacted) + the drawn signature.
        payment: (c.paymentDetails as Record<string, unknown> | null) ?? null,
        signatureImage: c.signatureImage ?? null,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  private buildContact(creator: Creator, contracts: Contract[]) {
    // Prefer the address stored directly on the master Creator (the source of
    // truth going forward); fall back to the latest contract that carries an
    // address so existing rows keep displaying correctly. Same fallback for
    // phone — a phone captured at signing time is used only if the master
    // record doesn't have one.
    const contractWithAddr = contracts.find(
      (c) => c.addressLine1 || c.addressCity || c.addressCountry,
    );
    const source = {
      line1: creator.addressLine1 ?? contractWithAddr?.addressLine1 ?? null,
      line2: creator.addressLine2 ?? contractWithAddr?.addressLine2 ?? null,
      city: creator.addressCity ?? contractWithAddr?.addressCity ?? null,
      state: creator.addressState ?? contractWithAddr?.addressState ?? null,
      postalCode: creator.addressPostalCode ?? contractWithAddr?.addressPostalCode ?? null,
      country: creator.addressCountry ?? contractWithAddr?.addressCountry ?? null,
    };
    const anyAddress =
      source.line1 || source.line2 || source.city || source.state || source.postalCode || source.country;
    const addr = anyAddress
      ? [source.line1, source.line2, source.city, source.state, source.postalCode, source.country]
          .filter(Boolean)
          .join(', ')
      : null;
    return {
      // Identity — exposed so the dashboard can render them in the Contact &
      // identity card alongside the address, all editable together.
      creatorName: contracts.find((c) => c.signerName)?.signerName ?? creator.creatorName ?? null,
      instagramUsername: creator.instagramUsername ?? null,
      address: addr,
      phone: creator.phoneNumber ?? contracts.find((c) => c.signerPhone)?.signerPhone ?? null,
      email: creator.email ?? contracts.find((c) => c.signerEmail)?.signerEmail ?? null,
      // Discrete address fields so the admin can edit them in place.
      addressFields: source,
    };
  }

  /**
   * Payout details for the profile screen. These are returned in full: the
   * console shows them directly on the Payment account card (there is no
   * "Reveal" step any more), and the tax identifiers are rendered in the
   * Contact & identity card. This endpoint sits behind the same guard as
   * `GET /roster/:id/contracts`, which has always returned the unredacted
   * payout JSON, so nothing is exposed here that an authorised caller could
   * not already read.
   */
  private buildPayment(creator: Creator, contracts: Contract[]) {
    // Prefer the master Creator record's payout details — that's the source of
    // truth going forward. Fall back to the first contract that carries any
    // paymentDetails so contracts signed before the Creator-level field existed
    // keep rendering the same way.
    const creatorPd = (creator.paymentDetails as Record<string, string> | null) ?? null;
    const contractWithPay = contracts.find((ct) => ct.paymentDetails);
    const contractPd = (contractWithPay?.paymentDetails as Record<string, string> | null) ?? null;
    const pd = creatorPd ?? contractPd;
    if (!pd) {
      return {
        accountHolder: null,
        accountHolderName: null,
        bankName: null,
        accountNumber: null,
        iban: null,
        routingNumber: null,
        ifscCode: null,
        swiftCode: null,
        panNumber: null,
        taxIdNumber: null,
        paymentMethod: null,
      };
    }
    let method: string | null = null;
    if (pd.routingNumber) method = 'ACH direct deposit';
    else if (pd.ifscCode) method = 'IMPS / NEFT (India)';
    else if (pd.iban || pd.swiftCode) method = 'International wire';
    else if (pd.accountNumber) method = 'Bank transfer';
    else if (contractWithPay?.paymentTerms) method = contractWithPay.paymentTerms;

    return {
      // Display value — falls back to the name on the signed contract when the
      // payout JSON doesn't carry one. `accountHolderName` is the raw stored
      // value, used to seed the edit form so an unedited save can't overwrite
      // the stored blank with the signer's name.
      accountHolder: pd.accountHolderName ?? contractWithPay?.signerName ?? null,
      accountHolderName: pd.accountHolderName ?? null,
      bankName: pd.bankName ?? null,
      accountNumber: pd.accountNumber ?? null,
      iban: pd.iban ?? null,
      routingNumber: pd.routingNumber ?? null,
      ifscCode: pd.ifscCode ?? null,
      swiftCode: pd.swiftCode ?? null,
      // Tax identifiers — rendered in the Contact & identity card, stored with
      // the rest of the payout JSON.
      panNumber: pd.panNumber ?? null,
      taxIdNumber: pd.taxIdNumber ?? null,
      paymentMethod: method,
    };
  }

  private buildUsageRights(latest: Contract | undefined, latestStats: CreatorStats | undefined) {
    return {
      usageRights: latest?.usageRights ?? 'Not specified',
      exclusivity: latest?.exclusivity ?? 'None',
      paidAdRights: latestStats?.paidAdRights ?? (latest?.usageRights ? 'See usage rights' : '—'),
      deadline: latest?.deadline ? latest.deadline.toISOString() : null,
    };
  }

  private buildDeliverables(contracts: Contract[]) {
    return contracts
      .filter((c) => c.deliverables || c.numberOfDeliverables)
      .map((c) => ({
        type: c.deliverables ?? `${c.numberOfDeliverables ?? ''} deliverables`.trim(),
        platform: c.platform ?? '—',
        due: c.deadline ? c.deadline.toISOString() : null,
        status: this.contractStatusLabel(c.status),
        campaign: c.campaignName ?? c.brandName ?? null,
      }));
  }

  /**
   * The campaigns a creator has participated in, drawn from BOTH signed
   * contracts and influence-stats performance snapshots (campaigns.influence
   * .technology). A campaign with a contract carries the full commercial detail
   * (deliverables, usage rights, exclusivity, value); a campaign we only know
   * from stats still shows up with its brand, platforms and views. Campaigns
   * present in both sources are merged into one row (keyed by campaign name).
   */
  private buildCampaignList(contracts: Contract[], stats: CreatorStats[]) {
    interface CampaignRow {
      campaign: string;
      brand: string;
      start: string | null;
      deadline: string | null;
      status: 'Active' | 'Completed' | 'Pending';
      deliverables: string | null;
      platform: string | null;
      numberOfDeliverables: number | null;
      usageRights: string | null;
      exclusivity: string | null;
      views: number | null;
      source: 'contract' | 'stats' | 'both';
    }

    const rows = new Map<string, CampaignRow>();
    const keyFor = (name: string | null | undefined, fallback: string): string => {
      const k = (name ?? '').trim().toLowerCase();
      return k || `id:${fallback}`;
    };

    // Contracts first — the richest source of commercial detail.
    for (const ct of contracts) {
      rows.set(keyFor(ct.campaignName, ct.id), {
        campaign: ct.campaignName ?? '—',
        brand: ct.brandName ?? '—',
        start: ct.createdAt.toISOString(),
        deadline: ct.deadline ? ct.deadline.toISOString() : null,
        status: this.contractStatusLabel(ct.status),
        deliverables: ct.deliverables ?? null,
        platform: ct.platform ?? null,
        numberOfDeliverables: ct.numberOfDeliverables ?? null,
        usageRights: ct.usageRights ?? null,
        exclusivity: ct.exclusivity ?? null,
        views: null,
        source: 'contract',
      });
    }

    // Stats snapshots — augment a matching campaign, or add a performance-only row.
    for (const s of stats) {
      const key = keyFor(s.campaignName, s.statsCampaignId);
      const existing = rows.get(key);
      const statsViews = s.totalViews ?? null;
      const statsPlatform = this.platformLabel(s.platforms);
      if (existing) {
        existing.views = (existing.views ?? 0) + (statsViews ?? 0);
        if (!existing.platform && statsPlatform) existing.platform = statsPlatform;
        if (existing.brand === '—' && s.brandName) existing.brand = s.brandName;
        if (!existing.deadline && s.deadline) existing.deadline = s.deadline.toISOString();
        if (existing.source === 'contract') existing.source = 'both';
      } else {
        rows.set(key, {
          campaign: s.campaignName ?? '—',
          brand: s.brandName ?? '—',
          start: null,
          deadline: s.deadline ? s.deadline.toISOString() : null,
          status: s.deliverablesComplete ? 'Completed' : 'Active',
          deliverables:
            s.minVideos != null ? `${s.minVideos} video${s.minVideos === 1 ? '' : 's'}` : null,
          platform: statsPlatform,
          numberOfDeliverables: s.videosPosted ?? s.minVideos ?? null,
          usageRights: s.paidAdRights ?? null,
          exclusivity: null,
          views: statsViews,
          source: 'stats',
        });
      }
    }

    return [...rows.values()];
  }

  private buildPlatformBreakdown(stats: CreatorStats[], combinedViews: number) {
    const agg = new Map<string, { views: number; likes: number; comments: number }>();
    for (const s of stats) {
      const videos = Array.isArray(s.videos) ? (s.videos as Array<Record<string, unknown>>) : [];
      for (const v of videos) {
        const views = (v.views as Record<string, number>) ?? {};
        const likes = (v.likes as Record<string, number>) ?? {};
        const comments = (v.comments as Record<string, number>) ?? {};
        for (const key of Object.keys(views)) {
          const code = RosterService.PLATFORM_CODE[key] ?? key.toUpperCase();
          const e = agg.get(code) ?? { views: 0, likes: 0, comments: 0 };
          e.views += Number(views[key]) || 0;
          e.likes += Number(likes[key]) || 0;
          e.comments += Number(comments[key]) || 0;
          agg.set(code, e);
        }
      }
    }

    // Fall back to the stored platform labels + combined views when there is no
    // per-post breakdown yet (e.g. stats synced before per-post detail existed).
    if (agg.size === 0) {
      const codes = new Set<string>();
      for (const s of stats) for (const code of this.platformCodes(s.platforms)) codes.add(code);
      const list = [...codes];
      return list.map((code) => ({
        code,
        name: RosterService.PLATFORM_NAME[code] ?? code,
        views: list.length ? Math.round(combinedViews / list.length) : combinedViews,
        engagement: null,
      }));
    }

    const maxViews = Math.max(...[...agg.values()].map((e) => e.views), 1);
    return ['IG', 'TT', 'YT']
      .filter((code) => agg.has(code))
      .map((code) => {
        const e = agg.get(code)!;
        return {
          code,
          name: RosterService.PLATFORM_NAME[code] ?? code,
          views: e.views,
          engagement: e.views > 0 ? Math.round(((e.likes + e.comments) / e.views) * 1000) / 10 : null,
          sharePct: Math.round((e.views / maxViews) * 100),
        };
      });
  }
}
