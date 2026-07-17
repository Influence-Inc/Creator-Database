/**
 * Pure mapping functions from influence-stats (ReelMetrics) bot payloads to our
 * internal shapes. Kept free of NestJS/DI so they're trivially unit-testable.
 *
 * A single stats creator maps to two things:
 *   1. a CreatorUpsertInput  — the analytics fields folded into the master
 *      Creator record (risk, cpm, average views/likes, engagement); and
 *   2. a CreatorStatsInput   — the full per-campaign snapshot (combined totals,
 *      commercials, deliverables, and the per-post breakdown) kept as durable
 *      history in the creator_stats table.
 */
import {
  normalizeEmail,
  normalizeInstagram,
  parseDateLoose,
  toBoundedInt,
  toNonNegativeFloat,
} from '../../common/utils/normalize';
import { CreatorUpsertInput } from '../../modules/creators/creator-fields.interface';
import { CreatorStatsInput } from '../../modules/creator-stats/creator-stats.service';
import { StatsCampaign, StatsCommercials, StatsCreator, StatsVideo } from './stats.types';

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** Round to 4 decimals so floating CPM/engagement values stay tidy. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function commercials(creator: StatsCreator): StatsCommercials {
  return (creator.commercials ?? {}) as StatsCommercials;
}

/** The CPM we fold into the master record: realized (actual) if known, else booked. */
function effectiveCpm(c: StatsCommercials): number | undefined {
  const realized = toNonNegativeFloat(c.realizedCpm);
  if (realized && realized > 0) return round4(realized);
  const booked = toNonNegativeFloat(c.bookedCpm);
  if (booked && booked > 0) return round4(booked);
  return undefined;
}

/**
 * Fold the analytics fields from a stats creator into the master Creator record.
 * Only fields influence-stats is the authority for are set (risk, realized CPM,
 * average views/likes, engagement) — negotiation/contract-owned fields are left
 * untouched. Identity comes from the email + username on the stats row.
 */
export function mapStatsToCreator(creator: StatsCreator): CreatorUpsertInput {
  const input: CreatorUpsertInput = {};

  const email = normalizeEmail(creator.email);
  if (email) input.email = email;

  const instagram = normalizeInstagram(creator.username);
  if (instagram) input.instagramUsername = instagram;

  const c = commercials(creator);
  const risk = str(c.risk);
  if (risk) input.riskLevel = risk;

  const cpm = effectiveCpm(c);
  if (cpm !== undefined) input.cpm = cpm;

  const totalViews = toBoundedInt(creator.totalViews);
  const totalLikes = toBoundedInt(creator.totalLikes);
  const totalComments = toBoundedInt(creator.totalComments);
  const posted = toBoundedInt(creator.totalVideosPosted);

  // Average per posted video, computed from real delivered numbers.
  if (posted && posted > 0) {
    if (totalViews !== null) input.averageViews = Math.round(totalViews / posted);
    if (totalLikes !== null) input.averageLikes = Math.round(totalLikes / posted);
  }

  // Engagement = (likes + comments) / views, as a fraction.
  if (totalViews && totalViews > 0 && (totalLikes !== null || totalComments !== null)) {
    input.engagementRate = round4(((totalLikes ?? 0) + (totalComments ?? 0)) / totalViews);
  }

  return input;
}

/** Build the per-campaign stats snapshot for the creator_stats table. */
export function mapStatsToSnapshot(
  creator: StatsCreator,
  campaign: StatsCampaign,
): CreatorStatsInput | null {
  const statsCampaignId = str(campaign.id);
  if (!statsCampaignId) return null;

  const c = commercials(creator);
  const del = creator.deliverables ?? {};
  const platforms = Array.isArray(creator.platforms) ? creator.platforms.filter(Boolean) : [];

  const videos: unknown[] = (creator.videos ?? []).map((v: StatsVideo) => ({
    id: v.id,
    title: v.title,
    uploadDate: v.uploadDate ?? null,
    hasLinks: v.hasLinks ?? false,
    links: v.links ?? {},
    views: v.views ?? {},
    likes: v.likes ?? {},
    comments: v.comments ?? {},
    totalViews: toBoundedInt(v.totalViews) ?? 0,
    totalLikes: toBoundedInt(v.totalLikes) ?? undefined,
    totalComments: toBoundedInt(v.totalComments) ?? undefined,
  }));

  return {
    statsCampaignId,
    campaignName: str(campaign.name) ?? null,
    brandName: str(campaign.brandName) ?? null,
    platforms: platforms.length ? platforms.join(', ') : null,

    totalViews: toBoundedInt(creator.totalViews),
    totalLikes: toBoundedInt(creator.totalLikes),
    totalComments: toBoundedInt(creator.totalComments),
    postCount: toBoundedInt(creator.videos?.length),
    videosPosted: toBoundedInt(creator.totalVideosPosted),

    riskLevel: str(c.risk) ?? null,
    bookedCpm: toNonNegativeFloat(c.bookedCpm),
    realizedCpm: toNonNegativeFloat(c.realizedCpm),
    budget: toNonNegativeFloat(c.budget),
    grossPay: toNonNegativeFloat(c.grossPay),
    creatorAsk: toNonNegativeFloat(c.creatorAsk),
    currency: str(c.currency) ?? undefined,
    paidAdRights: str(c.paidAdRights) ?? null,

    minViews: toBoundedInt(del.minViews),
    minVideos: toBoundedInt(del.minVideos),
    deliverablesComplete: del.allComplete ?? null,
    deadline: parseDateLoose(creator.deadline) ?? null,

    videos: videos as CreatorStatsInput['videos'],
  };
}
