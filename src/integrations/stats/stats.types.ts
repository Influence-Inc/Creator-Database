/**
 * Typings for the subset of the influence-stats (ReelMetrics) bot API this
 * service consumes: `GET /api/bot/campaigns`.
 *
 * The endpoint is defensive about which fields are populated (a campaign that
 * has never had commercial terms entered omits the `commercials` block, an
 * un-scraped post has zero views, etc.), so every field here is optional and
 * the mapper reads it defensively.
 */

export interface StatsVideo {
  id?: string;
  title?: string;
  uploadDate?: string | null;
  estPostDate?: string | null;
  hasLinks?: boolean;
  links?: Record<string, string | null>;
  /** Views per platform, e.g. { instagram: 1234, tiktok: 56 }. */
  views?: Record<string, number>;
  /** Likes per platform (present once influence-stats exposes engagement). */
  likes?: Record<string, number>;
  /** Comments per platform. */
  comments?: Record<string, number>;
  totalViews?: number;
  totalLikes?: number;
  totalComments?: number;
  [key: string]: unknown;
}

export interface StatsDeliverables {
  minViews?: number | null;
  minVideos?: number | null;
  actualViews?: number;
  actualVideos?: number;
  viewsComplete?: boolean;
  videosComplete?: boolean;
  allComplete?: boolean | null;
}

/** Per-creator commercial + risk block (added to the bot endpoint). */
export interface StatsCommercials {
  creatorAsk?: number | null;
  budget?: number | null;
  grossPay?: number | null;
  bookedCpm?: number | null;
  realizedCpm?: number | null;
  risk?: string | null;
  paidAdRights?: string | null;
  weightage?: number | null;
  currency?: string | null;
}

export interface StatsCreator {
  id?: string;
  username?: string;
  email?: string | null;
  deadline?: string | null;
  deliverables?: StatsDeliverables;
  videos?: StatsVideo[];
  totalViews?: number;
  totalLikes?: number;
  totalComments?: number;
  totalVideosPosted?: number;
  platforms?: string[];
  commercials?: StatsCommercials;
  [key: string]: unknown;
}

export interface StatsCampaign {
  id?: string;
  name?: string;
  brandName?: string;
  slug?: string;
  totalBudget?: number;
  createdAt?: number;
  creatorCount?: number;
  creators?: StatsCreator[];
}

export interface StatsCampaignsResponse {
  campaigns?: StatsCampaign[];
}
