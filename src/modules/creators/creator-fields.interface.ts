import { NegotiationStatus } from '@prisma/client';

/**
 * The full set of creator fields that any source (Instantly dashboard, Claude
 * extraction, or the manual API) may contribute during an upsert. Every field
 * is optional: `undefined` means "this source has nothing to say about it".
 *
 * Merge semantics (see CreatorsService.upsertFromSource):
 *   - `undefined` / `null` values never overwrite an existing value.
 *   - Identity keys (email, instagramUsername) are only *filled* when empty,
 *     never overwritten, to avoid identity drift and unique-constraint clashes.
 *   - All other provided values overwrite and are recorded in the activity log.
 */
export interface CreatorUpsertInput {
  // Identity
  creatorName?: string | null;
  instagramUsername?: string | null;
  instagramProfileLink?: string | null;
  email?: string | null;
  phoneNumber?: string | null;

  // Campaign info
  campaignName?: string | null;
  campaignId?: string | null;
  outreachStage?: string | null;
  assignedManager?: string | null;

  // Performance
  averageViews?: number | null;
  averageLikes?: number | null;
  engagementRate?: number | null;
  followers?: number | null;

  // Commercial
  cpm?: number | null;
  acceptedRate?: number | null;
  quotedRate?: number | null;
  currency?: string | null;

  // Deliverables
  numberOfVideos?: number | null;
  numberOfStories?: number | null;
  numberOfReels?: number | null;
  guaranteedViews?: number | null;
  deadline?: Date | null;
  deliverablesDescription?: string | null;

  // Communication
  latestEmailDate?: Date | null;
  lastReplyDate?: Date | null;
  threadId?: string | null;
  emailStatus?: string | null;

  // Deliverability
  inboxRate?: number | null;
  spamRate?: number | null;
  bounced?: boolean | null;
  opened?: boolean | null;
  replied?: boolean | null;

  // Negotiation status
  status?: NegotiationStatus | null;
}

/** Identity keys, in resolution priority order (email > instagram > name). */
export const IDENTITY_PRIORITY = ['email', 'instagramUsername', 'creatorName'] as const;

/** Non-identity fields merged normally (overwrite + log when they change). */
export const MERGEABLE_FIELDS: (keyof CreatorUpsertInput)[] = [
  'creatorName',
  'instagramProfileLink',
  'phoneNumber',
  'campaignName',
  'campaignId',
  'outreachStage',
  'assignedManager',
  'averageViews',
  'averageLikes',
  'engagementRate',
  'followers',
  'cpm',
  'acceptedRate',
  'quotedRate',
  'currency',
  'numberOfVideos',
  'numberOfStories',
  'numberOfReels',
  'guaranteedViews',
  'deadline',
  'deliverablesDescription',
  'latestEmailDate',
  'lastReplyDate',
  'threadId',
  'emailStatus',
  'inboxRate',
  'spamRate',
  'bounced',
  'opened',
  'replied',
  'status',
];

/** Identity keys that are only *filled* when empty, never overwritten. */
export const FILL_ONLY_FIELDS: (keyof CreatorUpsertInput)[] = ['email', 'instagramUsername'];
