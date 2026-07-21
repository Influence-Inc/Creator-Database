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

    // Track signed contracts per creator. "Used" = the creator has signed a
    // contract for at least one campaign (status SIGNED or COMPLETED); everyone
    // else — including creators with only unsigned/pending contracts or none at
    // all — is "Unused". Ingested contracts default to COMPLETED.
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
      return {
        id: c.id,
        name,
        handle: this.handle(c),
        initials: this.initials(name),
        platforms,
        campaigns: st?.count ?? 0,
        signedContracts,
        segment: signedContracts >= 1 ? 'used' : 'unused',
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
      campaigns: stats.length || contracts.length,

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
   * Admin edit of a creator's contact + payout details. Email/phone update the
   * master Creator; address + payout details update the creator's most recent
   * contract (the record of payment). Returns the refreshed profile.
   */
  async updateDetails(id: string, dto: UpdateDetailsDto): Promise<unknown> {
    const creator = await this.prisma.creator.findUnique({ where: { id } });
    if (!creator) throw new NotFoundException(`Creator ${id} not found`);

    const contact = dto.contact ?? {};
    const payment = dto.payment ?? {};

    // 1. Creator-level identity/contact.
    const creatorData: Prisma.CreatorUncheckedUpdateInput = {};
    if (contact.email !== undefined) creatorData.email = contact.email || null;
    if (contact.phone !== undefined) creatorData.phoneNumber = contact.phone || null;
    if (Object.keys(creatorData).length) {
      try {
        await this.prisma.creator.update({ where: { id }, data: creatorData });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BadRequestException('That email is already assigned to another creator');
        }
        throw err;
      }
    }

    // 2. Address + payout live on the latest contract.
    const latest = await this.prisma.contract.findFirst({
      where: { creatorId: id },
      orderBy: { createdAt: 'desc' },
    });
    const wantsContractEdit =
      contact.address !== undefined || contact.phone !== undefined || Object.keys(payment).length > 0;

    if (wantsContractEdit) {
      if (!latest) {
        throw new BadRequestException(
          'This creator has no contract yet, so address and payout details cannot be stored',
        );
      }
      const contractData: Prisma.ContractUncheckedUpdateInput = {};
      if (contact.phone !== undefined) contractData.signerPhone = contact.phone || null;
      const a = contact.address;
      if (a !== undefined) {
        contractData.addressLine1 = a.line1 ?? null;
        contractData.addressLine2 = a.line2 ?? null;
        contractData.addressCity = a.city ?? null;
        contractData.addressState = a.state ?? null;
        contractData.addressPostalCode = a.postalCode ?? null;
        contractData.addressCountry = a.country ?? null;
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
    const withAddr = contracts.find((c) => c.addressLine1 || c.addressCity || c.addressCountry);
    const addr = withAddr
      ? [
          withAddr.addressLine1,
          withAddr.addressLine2,
          withAddr.addressCity,
          withAddr.addressState,
          withAddr.addressPostalCode,
          withAddr.addressCountry,
        ]
          .filter(Boolean)
          .join(', ')
      : null;
    return {
      address: addr,
      phone: contracts.find((c) => c.signerPhone)?.signerPhone ?? creator.phoneNumber ?? null,
      email: creator.email ?? contracts.find((c) => c.signerEmail)?.signerEmail ?? null,
      // Discrete address fields so the admin can edit them in place.
      addressFields: {
        line1: withAddr?.addressLine1 ?? null,
        line2: withAddr?.addressLine2 ?? null,
        city: withAddr?.addressCity ?? null,
        state: withAddr?.addressState ?? null,
        postalCode: withAddr?.addressPostalCode ?? null,
        country: withAddr?.addressCountry ?? null,
      },
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
