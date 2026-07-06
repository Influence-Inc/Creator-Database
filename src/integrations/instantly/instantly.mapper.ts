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

/** Read a value across candidate keys, checking top-level then `payload`. */
function readField(lead: InstantlyLead, keys: string[]): unknown {
  const payload =
    lead.payload && typeof lead.payload === 'object'
      ? (lead.payload as Record<string, unknown>)
      : {};
  const payloadLower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) payloadLower[k.toLowerCase()] = v;

  for (const key of keys) {
    const top = (lead as Record<string, unknown>)[key];
    if (top !== undefined && top !== null && top !== '') return top;
    const inPayload = payloadLower[key.toLowerCase()];
    if (inPayload !== undefined && inPayload !== null && inPayload !== '') return inPayload;
  }
  return undefined;
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

  const instagram = normalizeInstagram(
    readField(lead, ['instagram', 'instagram_username', 'ig', 'ig_username', 'instagram_handle']),
  );
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
