import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Contract, Creator, CreatorStats, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UpdateDetailsDto } from './dto/update-details.dto';

/**
 * Read-model that powers the admin Creator Database UI (served from /public).
 *
 * It composes the master `Creator` record with its influence-stats snapshots
 * (`creator_stats`) and signed `contracts` into the exact shapes the roster and
 * profile screens render — so the browser makes one call per screen instead of
 * fanning out across three endpoints and doing joins client-side.
 *
 * Sensitive payout data never leaves the server intact: full account numbers,
 * IBANs and the signature image are redacted here (only a masked last-4 and an
 * "on file" flag are exposed).
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

  private displayName(c: Creator): string {
    return c.creatorName || c.instagramUsername || c.email || 'Unknown creator';
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
      { active: number; signed: number; signature: boolean; lastCampaign: string | null }
    >();
    for (const ct of contracts) {
      const e =
        contractsByCreator.get(ct.creatorId) ?? {
          active: 0,
          signed: 0,
          signature: false,
          lastCampaign: null,
        };
      if (ct.status === 'SIGNED') e.active += 1;
      if (ct.status === 'SIGNED' || ct.status === 'COMPLETED') e.signed += 1;
      if (ct.signatureImage) e.signature = true;
      if (!e.lastCampaign && ct.campaignName) e.lastCampaign = ct.campaignName; // rows are newest-first
      contractsByCreator.set(ct.creatorId, e);
    }

    const order = ['IG', 'TT', 'YT'];
    const mapped = creators.map((c) => {
      const st = statsByCreator.get(c.id);
      const ct = contractsByCreator.get(c.id);
      const platforms = st ? order.filter((code) => st.platforms.has(code)) : [];
      const name = this.displayName(c);
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
      name: this.displayName(creator),
      handle: this.handle(creator),
      initials: this.initials(this.displayName(creator)),
      risk: this.normalizeRisk(creator.riskLevel),
      followers: creator.followers,
      views: combinedViews,
      cpm: creator.cpm,
      engagement: this.engagementPct(creator.engagementRate),
      campaigns: campaignList.length,
      // Unified campaign list (contracts + stats) shown in the Campaigns tab.
      campaignList,

      contact: this.buildContact(creator, contracts),
      payment: this.buildPayment(contracts),
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
   * Payout details (bank / IBAN / tax IDs) still require a contract — payment
   * runs are attached to the specific contract they were paid against; there's
   * no meaningful place to attach them without one.
   */
  async updateDetails(id: string, dto: UpdateDetailsDto): Promise<unknown> {
    const creator = await this.prisma.creator.findUnique({ where: { id } });
    if (!creator) throw new NotFoundException(`Creator ${id} not found`);

    const contact = dto.contact ?? {};
    const payment = dto.payment ?? {};

    // 1. Master Creator: identity + all contact fields (email/phone/address).
    //    Empty string clears the field; undefined leaves it untouched.
    const norm = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);
    const creatorData: Prisma.CreatorUncheckedUpdateInput = {};
    if (contact.creatorName !== undefined) creatorData.creatorName = norm(contact.creatorName);
    if (contact.instagramUsername !== undefined) {
      const raw = norm(contact.instagramUsername);
      creatorData.instagramUsername = raw ? raw.replace(/^@+/, '').toLowerCase() : null;
    }
    if (contact.email !== undefined) creatorData.email = norm(contact.email);
    if (contact.phone !== undefined) creatorData.phoneNumber = norm(contact.phone);
    if (contact.address !== undefined) {
      const a = contact.address;
      creatorData.addressLine1 = norm(a.line1);
      creatorData.addressLine2 = norm(a.line2);
      creatorData.addressCity = norm(a.city);
      creatorData.addressState = norm(a.state);
      creatorData.addressPostalCode = norm(a.postalCode);
      creatorData.addressCountry = norm(a.country);
    }
    if (Object.keys(creatorData).length) {
      try {
        await this.prisma.creator.update({ where: { id }, data: creatorData });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BadRequestException(
            'That email or Instagram handle is already assigned to another creator',
          );
        }
        throw err;
      }
    }

    // 2. If a contract exists, mirror phone + address onto the LATEST contract so
    //    the payment record stays in sync. Optional — a creator with no contract
    //    is now perfectly valid to have contact / identity data on file.
    const latest = await this.prisma.contract.findFirst({
      where: { creatorId: id },
      orderBy: { createdAt: 'desc' },
    });

    if (latest) {
      const contractData: Prisma.ContractUncheckedUpdateInput = {};
      if (contact.phone !== undefined) contractData.signerPhone = norm(contact.phone);
      if (contact.address !== undefined) {
        const a = contact.address;
        contractData.addressLine1 = norm(a.line1);
        contractData.addressLine2 = norm(a.line2);
        contractData.addressCity = norm(a.city);
        contractData.addressState = norm(a.state);
        contractData.addressPostalCode = norm(a.postalCode);
        contractData.addressCountry = norm(a.country);
      }
      if (Object.keys(payment).length > 0) {
        const existing = (latest.paymentDetails as Record<string, unknown> | null) ?? {};
        const merged: Record<string, unknown> = { ...existing };
        for (const [k, v] of Object.entries(payment)) merged[k] = v === '' ? undefined : v;
        // Drop keys explicitly cleared to empty.
        for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
        contractData.paymentDetails = merged as Prisma.InputJsonValue;
      }
      if (Object.keys(contractData).length) {
        await this.prisma.contract.update({ where: { id: latest.id }, data: contractData });
      }
    } else if (Object.keys(payment).length > 0) {
      // Payment-only edit without a contract has nowhere to land. Contact /
      // identity above already succeeded — payment is what's rejected.
      throw new BadRequestException(
        'This creator has no contract yet, so payout details cannot be stored',
      );
    }

    return this.profile(id);
  }

  /**
   * Full, UNREDACTED signed contracts for a creator — including the complete
   * payout details (full account number / IBAN) and the signature image. This
   * is the payment-processing / contract-review view, deliberately separate from
   * profile() (which masks payout data) so the sensitive fields are only sent on
   * an explicit admin request, still behind the same auth guard.
   */
  async contractsFull(creatorId: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { id: creatorId },
      select: { id: true, creatorName: true, instagramUsername: true },
    });
    if (!creator) throw new NotFoundException(`Creator ${creatorId} not found`);

    const contracts = await this.prisma.contract.findMany({
      where: { creatorId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      creatorId: creator.id,
      creatorName: creator.creatorName ?? creator.instagramUsername ?? null,
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
      creatorName: creator.creatorName ?? null,
      instagramUsername: creator.instagramUsername ?? null,
      address: addr,
      phone: creator.phoneNumber ?? contracts.find((c) => c.signerPhone)?.signerPhone ?? null,
      email: creator.email ?? contracts.find((c) => c.signerEmail)?.signerEmail ?? null,
      // Discrete address fields so the admin can edit them in place.
      addressFields: source,
    };
  }

  private last4(value: string | null | undefined): string | null {
    if (!value) return null;
    const digits = String(value).replace(/\s+/g, '');
    return digits.length >= 4 ? digits.slice(-4) : digits;
  }

  private buildPayment(contracts: Contract[]) {
    const c = contracts.find((ct) => ct.paymentDetails);
    const pd = (c?.paymentDetails as Record<string, string> | null) ?? null;
    if (!pd) {
      return { accountHolder: null, bankLast4: null, paymentMethod: null, taxStatus: null };
    }
    let method: string | null = null;
    if (pd.routingNumber) method = 'ACH direct deposit';
    else if (pd.ifscCode) method = 'IMPS / NEFT (India)';
    else if (pd.iban || pd.swiftCode) method = 'International wire';
    else if (pd.accountNumber) method = 'Bank transfer';
    else if (c?.paymentTerms) method = c.paymentTerms;

    const taxStatus = pd.taxIdNumber || pd.panNumber ? 'Tax ID on file' : 'Not provided';

    return {
      accountHolder: pd.accountHolderName ?? c?.signerName ?? null,
      bankLast4: this.last4(pd.accountNumber ?? pd.iban),
      paymentMethod: method,
      taxStatus,
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
