/** Deliverable counts as extracted by Claude (any may be null when unknown). */
export interface ClaudeDeliverables {
  videos: number | null;
  stories: number | null;
  reels: number | null;
}

/**
 * Normalized shape of Claude's JSON extraction. Numeric-ish fields are kept as
 * `string | number | null` here because the model may return "40k"/"2M" style
 * values; the mapper (claude.mapper.ts) coerces them into typed numbers.
 */
export interface ClaudeExtraction {
  name: string | null;
  instagram: string | null;
  email: string | null;
  deadline: string | null;
  campaign: string | null;
  accepted_rate: string | number | null;
  currency: string | null;
  guaranteed_views: string | number | null;
  deliverables: ClaudeDeliverables;
  notes: string | null;
  status: string | null;
}

/** Raised when Claude cannot return parseable JSON after all retries. */
export class ClaudeExtractionError extends Error {
  constructor(
    message: string,
    readonly rawResponse?: string,
  ) {
    super(message);
    this.name = 'ClaudeExtractionError';
  }
}
