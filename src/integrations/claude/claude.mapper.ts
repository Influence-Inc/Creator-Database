/**
 * Pure mapping from a Claude extraction to a creator upsert input. Coerces the
 * model's loose values ("40k", "July 18") into typed fields using the shared
 * normalization helpers, and maps the free-text status to our enum.
 */
import { NegotiationStatus } from '@prisma/client';
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
import { ClaudeExtraction } from './claude.types';

const STATUS_MAP: Record<string, NegotiationStatus> = {
  pending: NegotiationStatus.PENDING,
  negotiating: NegotiationStatus.NEGOTIATING,
  negotiation: NegotiationStatus.NEGOTIATING,
  accepted: NegotiationStatus.ACCEPTED,
  agreed: NegotiationStatus.ACCEPTED,
  confirmed: NegotiationStatus.ACCEPTED,
  rejected: NegotiationStatus.REJECTED,
  declined: NegotiationStatus.REJECTED,
  passed: NegotiationStatus.REJECTED,
  completed: NegotiationStatus.COMPLETED,
  done: NegotiationStatus.COMPLETED,
};

export function mapExtractionStatus(status: string | null): NegotiationStatus | undefined {
  if (!status) return undefined;
  return STATUS_MAP[status.trim().toLowerCase()];
}

/**
 * Map a Claude extraction to a creator upsert input. Only fields that were
 * actually extracted (non-null after coercion) are set, so a partial thread
 * never wipes out data learned from the outreach dashboard or earlier emails.
 */
export function mapExtractionToCreator(
  extraction: ClaudeExtraction,
  context: { threadId?: string; lastReplyDate?: Date } = {},
): CreatorUpsertInput {
  const input: CreatorUpsertInput = {};

  const email = normalizeEmail(extraction.email);
  if (email) input.email = email;

  const instagram = normalizeInstagram(extraction.instagram);
  if (instagram) input.instagramUsername = instagram;

  const name = normalizeName(extraction.name);
  if (name) input.creatorName = name;

  const campaign = normalizeName(extraction.campaign);
  if (campaign) input.campaignName = campaign;

  const acceptedRate = toNonNegativeFloat(extraction.accepted_rate);
  if (acceptedRate !== null) input.acceptedRate = acceptedRate;

  const currency = normalizeCurrency(extraction.currency);
  if (currency) input.currency = currency;

  const guaranteedViews = toBoundedInt(extraction.guaranteed_views);
  if (guaranteedViews !== null) input.guaranteedViews = guaranteedViews;

  const videos = toBoundedInt(extraction.deliverables?.videos);
  if (videos !== null) input.numberOfVideos = videos;
  const stories = toBoundedInt(extraction.deliverables?.stories);
  if (stories !== null) input.numberOfStories = stories;
  const reels = toBoundedInt(extraction.deliverables?.reels);
  if (reels !== null) input.numberOfReels = reels;

  const deadline = parseDateLoose(extraction.deadline);
  if (deadline) input.deadline = deadline;

  const notes = normalizeName(extraction.notes);
  if (notes) input.deliverablesDescription = notes;

  const status = mapExtractionStatus(extraction.status);
  if (status) input.status = status;

  if (context.threadId) input.threadId = context.threadId;
  if (context.lastReplyDate) input.lastReplyDate = context.lastReplyDate;
  input.replied = true; // a thread we extracted from implies the creator engaged

  return input;
}
