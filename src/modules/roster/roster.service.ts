import { Injectable, NotFoundException } from '@nestjs/common';
import { Contract, Creator, CreatorStats } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

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

    const contractsByCreator = new Map<
      string,
      { active: number; signature: boolean; lastCampaign: string | null }
    >();
    for (const ct of contracts) {
      const e =
        contractsByCreator.get(ct.creatorId) ?? { active: 0, signature: false, lastCampaign: null };
      if (ct.status === 'SIGNED') e.active += 1;
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
      return {
        id: c.id,
        name,
        handle: this.handle(c),
        initials: this.initials(name),
        platforms,
        campaigns: st?.count ?? 0,
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
      })),
      platformBreakdown: this.buildPlatformBreakdown(stats, combinedViews),
      riskAssessment: this.buildRiskAssessment(creator, stats, contracts),
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
    const signed = contracts.find((c) => c.signatureImage || c.signerName);
    return {
      address: addr,
      phone: contracts.find((c) => c.signerPhone)?.signerPhone ?? creator.phoneNumber ?? null,
      email: creator.email ?? contracts.find((c) => c.signerEmail)?.signerEmail ?? null,
      signature: !!signed?.signatureImage,
      signerName: signed?.signerName ?? null,
      signedDate: signed
        ? (signed.signerSignedDate ?? signed.signedAt)?.toISOString() ?? null
        : null,
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

  private buildRiskAssessment(creator: Creator, stats: CreatorStats[], contracts: Contract[]) {
    const risk = this.normalizeRisk(creator.riskLevel);
    const completed = stats.filter((s) => s.deliverablesComplete === true).length;
    const withDeliverables = stats.filter((s) => s.deliverablesComplete !== null).length;
    const hasTax = contracts.some((c) => {
      const pd = c.paymentDetails as Record<string, string> | null;
      return pd && (pd.taxIdNumber || pd.panNumber);
    });
    const signed = contracts.some((c) => c.signatureImage);

    const compliance = risk === 'High' ? 'Review required' : risk === 'Med' ? 'Monitor' : 'Clean';
    const payment = hasTax ? 'Tax form on file' : 'Tax form outstanding';
    const delivery = withDeliverables
      ? `${completed}/${withDeliverables} campaigns complete`
      : 'No history yet';

    const notes: string[] = [];
    notes.push(
      `${stats.length || contracts.length} campaign${
        (stats.length || contracts.length) === 1 ? '' : 's'
      } on record`,
    );
    if (!signed) notes.push('signed contract missing');
    if (!hasTax) notes.push('tax details outstanding');
    if (risk === 'High') notes.push('flagged high-risk — review before renewal');

    return {
      note: `${notes.join(' · ')}.`.replace(/^./, (m) => m.toUpperCase()),
      factors: { compliance, payment, delivery },
    };
  }
}
