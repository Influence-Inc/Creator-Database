/**
 * Pure mapping functions from Instantly payloads to our internal shapes.
 *
 * Kept free of NestJS/DI so they're trivially unit-testable, and defensive
 * about field names because Instantly stores the outreach-dashboard columns
 * (Instagram handle, average views, CPM, accepted rate, manager…) as
 * campaign-specific custom variables inside each lead's `payload`.
 */
import { CreatorUpsertInput } from '../../modules/creators/creator-fields.interface';
import {
  normalizeCurrency,
  normalizeEmail,
  normalizeInstagram,
  normalizeName,
  parseDateLoose,
  toBoundedInt,
  toNonNegativeFloat,
} from '../../common/utils/normalize';
import { InstantlyEmail, InstantlyLead } from './instantly.types';

/** Best-effort human labels for Instantly's numeric lead-status codes. */
export const LEAD_STATUS_LABELS: Record<string, string> = {
  '1': 'Active',
  '2': 'Completed',
  '3': 'Unsubscribed',
  '-1': 'Bounced',
  '-2': 'Unsubscribed',
  '-3': 'Skipped',
};

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * Reduce a key to lowercase alphanumerics so that dashboard-column names like
 * "Instagram Handle", "instagram_handle", "instagramHandle" and "IG Handle "
 * all compare equal. Instantly stores custom variables under whatever label the
 * operator typed (usually Title Case with spaces), so matching on the raw or
 * merely lower-cased key misses almost everything.
 */
function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Build a normalized-key -> value lookup, keeping the first value per key. */
function normalizedLookup(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    const nk = normKey(k);
    if (nk && out[nk] === undefined) out[nk] = v;
  }
  return out;
}

/**
 * Read a value across candidate keys, checking top-level then `payload`.
 * Matching is done on normalized keys (alphanumerics only) so spacing and
 * casing in Instantly's custom-variable labels don't cause misses.
 */
function readField(lead: InstantlyLead, keys: string[]): unknown {
  const payload =
    lead.payload && typeof lead.payload === 'object'
      ? (lead.payload as Record<string, unknown>)
      : {};
  const payloadNorm = normalizedLookup(payload);
  const topNorm = normalizedLookup(lead as Record<string, unknown>);

  for (const key of keys) {
    const nk = normKey(key);
    const top = topNorm[nk];
    if (top !== undefined && top !== null && top !== '') return top;
    const inPayload = payloadNorm[nk];
    if (inPayload !== undefined && inPayload !== null && inPayload !== '') return inPayload;
  }
  return undefined;
}

/**
 * Last-resort Instagram lookup: scan every string in the lead (top-level and
 * payload) for an instagram.com profile URL and pull the handle out. Only
 * matches real IG URLs, so it can never mistake a name or city for a handle.
 */
function scanForInstagramUrl(lead: InstantlyLead): string | null {
  const sources: Record<string, unknown>[] = [lead as Record<string, unknown>];
  if (lead.payload && typeof lead.payload === 'object') {
    sources.push(lead.payload as Record<string, unknown>);
  }
  for (const source of sources) {
    for (const value of Object.values(source)) {
      if (typeof value === 'string' && /instagram\.com\//i.test(value)) {
        const handle = normalizeInstagram(value);
        if (handle) return handle;
      }
    }
  }
  return null;
}

function joinName(first?: string, last?: string): string | undefined {
  const joined = [first, last].filter((p) => p && p.trim()).join(' ');
  return joined || undefined;
}

function mapLeadStatus(status: unknown): string | undefined {
  if (status === undefined || status === null || status === '') return undefined;
  const key = String(status);
  return LEAD_STATUS_LABELS[key] ?? `Status ${key}`;
}

export interface LeadMapContext {
  /** Our local Campaign.id (FK), not the Instantly campaign UUID. */
  campaignId?: string;
  campaignName?: string;
}

/**
 * Map an Instantly lead (an outreach-dashboard row) to a creator upsert input.
 * Only fields that are actually present are set, so absent columns never
 * overwrite data learned from other sources.
 */
export function mapLeadToCreator(
  lead: InstantlyLead,
  ctx: LeadMapContext = {},
): CreatorUpsertInput {
  const input: CreatorUpsertInput = {};

  const email = normalizeEmail(lead.email);
  if (email) input.email = email;

  const instagram =
    normalizeInstagram(
      readField(lead, [
        'instagram',
        'instagram_username',
        'ig',
        'ig_username',
        'instagram_handle',
        'ig_handle',
        'insta',
        'insta_handle',
        'instagram_id',
        'instagram_profile',
        'instagram_profile_link',
        'instagram_link',
        'instagram_url',
        'ig_link',
        'profile_link',
      ]),
    ) ?? scanForInstagramUrl(lead);
  if (instagram) input.instagramUsername = instagram;

  const creatorName = normalizeName(
    readField(lead, ['creator_name', 'name', 'full_name']) ??
      joinName(str(lead.first_name), str(lead.last_name)),
  );
  if (creatorName) input.creatorName = creatorName;

  if (ctx.campaignId) input.campaignId = ctx.campaignId;
  if (ctx.campaignName) input.campaignName = ctx.campaignName;

  const manager = normalizeName(
    readField(lead, ['manager', 'assigned_manager', 'account_manager', 'owner']),
  );
  if (manager) input.assignedManager = manager;

  const outreachStage =
    str(readField(lead, ['outreach_status', 'outreach_stage', 'status_label'])) ??
    mapLeadStatus(lead.status);
  if (outreachStage) input.outreachStage = outreachStage;

  const averageViews = toBoundedInt(
    readField(lead, ['average_views', 'avg_views', 'averageViews', 'views']),
  );
  if (averageViews !== null) input.averageViews = averageViews;

  const averageLikes = toBoundedInt(readField(lead, ['average_likes', 'avg_likes']));
  if (averageLikes !== null) input.averageLikes = averageLikes;

  const followers = toBoundedInt(readField(lead, ['followers', 'follower_count']));
  if (followers !== null) input.followers = followers;

  const engagementRate = toNonNegativeFloat(readField(lead, ['engagement_rate', 'engagementRate']));
  if (engagementRate !== null) input.engagementRate = engagementRate;

  const cpm = toNonNegativeFloat(readField(lead, ['cpm']));
  if (cpm !== null) input.cpm = cpm;

  const acceptedRate = toNonNegativeFloat(
    readField(lead, ['accepted_rate', 'acceptedRate', 'rate']),
  );
  if (acceptedRate !== null) input.acceptedRate = acceptedRate;

  const quotedRate = toNonNegativeFloat(readField(lead, ['quoted_rate', 'quotedRate']));
  if (quotedRate !== null) input.quotedRate = quotedRate;

  const currency = normalizeCurrency(readField(lead, ['currency']));
  if (currency) input.currency = currency;

  const latestActivity = parseDateLoose(
    readField(lead, ['timestamp_last_contact', 'latest_activity', 'last_activity']),
  );
  if (latestActivity) input.latestEmailDate = latestActivity;

  return input;
}

export interface MappedEmail {
  messageId: string;
  threadId: string;
  sender?: string;
  recipient?: string;
  subject?: string;
  timestamp?: Date;
  rawEmail: string;
}

/** Map an Instantly email into an EmailHistory upsert input. */
export function mapEmail(email: InstantlyEmail): MappedEmail | null {
  const messageId = str(email.id) ?? str(email.message_id);
  if (!messageId) return null;

  const threadId = str(email.thread_id) ?? messageId;
  const sender = str(email.from_address_email) ?? str(email.from);
  const recipient = str(email.to_address_email_list) ?? str(email.to);
  const subject = str(email.subject);
  const timestamp =
    parseDateLoose(email.timestamp_email) ?? parseDateLoose(email.timestamp) ?? undefined;

  let rawEmail = '';
  const body = email.body;
  if (typeof body === 'string') {
    rawEmail = body;
  } else if (body && typeof body === 'object') {
    rawEmail = body.text ?? body.html ?? '';
  }
  if (!rawEmail) rawEmail = str(email.content_preview) ?? '';

  return {
    messageId,
    threadId,
    sender,
    recipient,
    subject,
    timestamp: timestamp ?? undefined,
    rawEmail,
  };
}
