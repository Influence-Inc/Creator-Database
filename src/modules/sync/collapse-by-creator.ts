import { CreatorUpsertInput } from '../creators/creator-fields.interface';

/**
 * One upstream row (an Instantly lead, an influence-stats campaign creator)
 * mapped to a creator upsert, plus how it ranks against the creator's other rows.
 */
export interface RankedRow<T> {
  input: CreatorUpsertInput;
  /** Higher wins. A timestamp (ms) for recency; 0 when unknown. */
  rank: number;
  /** Deterministic tie-break when ranks are equal (lower wins), e.g. a campaign id. */
  tiebreak: string;
  item: T;
}

export interface CreatorGroup<T> {
  /** One upsert carrying the winning value of every field. */
  input: CreatorUpsertInput;
  /** The rows folded into it, best first. */
  rows: RankedRow<T>[];
}

/** Dates that only ever move forward: the newest across all rows wins. */
const LATEST_WINS: (keyof CreatorUpsertInput)[] = ['latestEmailDate', 'lastReplyDate'];

/**
 * Group a run's rows by real-world creator and fold each group into a single
 * upsert.
 *
 * Why this exists: the master Creator record holds one campaignName, one
 * averageViews, one riskLevel… but a creator can be a lead in several Instantly
 * campaigns, or appear in several influence-stats campaigns. Upserting each row
 * on its own made the record flip between campaigns' values several times per
 * run, and every flip was written to activity_logs — ~15M rows, which filled
 * the Postgres volume. Folding first means each run writes each creator once,
 * with the same winner every time, so only real changes are logged.
 *
 * Rows join the same group when they share an email or an Instagram handle
 * (transitively, so a lead with only an email and one with email + handle
 * still merge). A row with neither falls back to its normalized name. Rows
 * with no identity at all are dropped — upsertFromSource would skip them.
 *
 * Within a group the best row (highest rank, then lowest tiebreak) supplies
 * each field; lower rows only fill fields it doesn't have. LATEST_WINS dates
 * take the newest value across the group.
 */
export function collapseByCreator<T>(rows: RankedRow<T>[]): CreatorGroup<T>[] {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const owner = new Map<string, number>();
  const keep: boolean[] = rows.map(() => false);
  rows.forEach((row, i) => {
    const keys: string[] = [];
    if (row.input.email) keys.push(`e:${row.input.email.toLowerCase()}`);
    if (row.input.instagramUsername) keys.push(`ig:${row.input.instagramUsername.toLowerCase()}`);
    if (keys.length === 0 && row.input.creatorName) {
      keys.push(`n:${row.input.creatorName.trim().toLowerCase()}`);
    }
    if (keys.length === 0) return;
    keep[i] = true;
    for (const key of keys) {
      const seen = owner.get(key);
      if (seen === undefined) owner.set(key, i);
      else union(seen, i);
    }
  });

  const groups = new Map<number, RankedRow<T>[]>();
  rows.forEach((row, i) => {
    if (!keep[i]) return;
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(row);
    else groups.set(root, [row]);
  });

  const out: CreatorGroup<T>[] = [];
  for (const members of groups.values()) {
    members.sort((a, b) =>
      b.rank !== a.rank ? b.rank - a.rank : a.tiebreak.localeCompare(b.tiebreak),
    );
    out.push({ input: mergeInputs(members.map((m) => m.input)), rows: members });
  }
  return out;
}

/** Fold inputs (best first) into one: first non-empty value wins, dates take the max. */
export function mergeInputs(inputs: CreatorUpsertInput[]): CreatorUpsertInput {
  const merged: Record<string, unknown> = {};
  for (const input of inputs) {
    for (const [field, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;
      const current = merged[field];
      if (LATEST_WINS.includes(field as keyof CreatorUpsertInput)) {
        const next = value instanceof Date ? value : new Date(value as string);
        const prev = current instanceof Date ? current : undefined;
        if (!prev || next.getTime() > prev.getTime()) merged[field] = next;
      } else if (current === undefined) {
        merged[field] = value;
      }
    }
  }
  return merged as CreatorUpsertInput;
}
