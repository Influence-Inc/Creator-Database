/**
 * Per-key result of POST /creators/categorize. Category:
 *   • 'used'   — creator exists in the DB and has ≥1 contract row (any status)
 *   • 'unused' — creator exists in the DB but has NO contracts
 *   • 'new'    — no creator matches this key
 * `creator` is populated for used/unused so the caller can render the badge
 * with the master record's canonical fields (name, IG, email, contract count).
 */
export interface CategorizeResult {
  key: { email: string | null; instagramUsername: string | null };
  category: 'used' | 'unused' | 'new';
  creator: {
    id: string;
    creatorName: string | null;
    email: string | null;
    instagramUsername: string | null;
    contractsCount: number;
  } | null;
}
