/**
 * Normalization + light validation helpers shared by the merge logic,
 * the Instantly mapper and the Claude extraction mapper. Keeping these pure
 * and in one place makes identity resolution deterministic and testable.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Instagram handles: letters, numbers, periods, underscores; 1-30 chars.
const INSTAGRAM_RE = /^[a-z0-9._]{1,30}$/;
// ISO-4217-ish: 3 uppercase letters. We don't validate against the full list.
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Lower-case + trim an email, returning null when it isn't a valid address. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || !EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Normalize an Instagram username: strip a leading @, drop a full profile URL
 * down to its handle, lower-case, and validate the handle shape.
 */
export function normalizeInstagram(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let handle = value.trim();
  if (!handle) return null;

  // Pull the handle out of a profile URL if one was passed.
  const urlMatch = handle.match(/instagram\.com\/([^/?#\s]+)/i);
  if (urlMatch) handle = urlMatch[1];

  handle = handle.replace(/^@/, '').toLowerCase();
  if (!INSTAGRAM_RE.test(handle)) return null;
  return handle;
}

/** Build a canonical profile link from a handle. */
export function instagramProfileLink(handle: string | null): string | null {
  return handle ? `https://instagram.com/${handle}` : null;
}

/** Collapse whitespace and trim a display name; null when empty. */
export function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Validate a 3-letter currency code, upper-cased. Defaults handled by caller. */
export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return CURRENCY_RE.test(upper) ? upper : null;
}

/**
 * Parse a monetary/number-like value that may arrive as a string such as
 * "40k", "2M", "$40,000", "1.2m". Returns null for anything unparseable.
 */
export function parseNumericLoose(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  // Strip everything except digits, decimal point, sign, and the k/m/b suffix
  // (removes currency symbols like $ £ €, thousands separators, and stray text).
  let str = value
    .trim()
    .toLowerCase()
    .replace(/[^0-9.kmb+-]/g, '');
  if (!str) return null;

  let multiplier = 1;
  if (str.endsWith('k')) {
    multiplier = 1_000;
    str = str.slice(0, -1);
  } else if (str.endsWith('m')) {
    multiplier = 1_000_000;
    str = str.slice(0, -1);
  } else if (str.endsWith('b')) {
    multiplier = 1_000_000_000;
    str = str.slice(0, -1);
  }

  const parsed = Number.parseFloat(str);
  if (!Number.isFinite(parsed)) return null;
  return parsed * multiplier;
}

/** Non-negative integer within Postgres INT range, else null (views/counts). */
export function toBoundedInt(value: unknown): number | null {
  const num = parseNumericLoose(value);
  if (num === null) return null;
  const rounded = Math.round(num);
  if (rounded < 0 || rounded > 2_147_483_647) return null;
  return rounded;
}

/** Non-negative float (rates, ratios, CPM), else null. */
export function toNonNegativeFloat(value: unknown): number | null {
  const num = parseNumericLoose(value);
  if (num === null || num < 0) return null;
  return num;
}

/**
 * Parse a date from an ISO string, a Date, or a loose phrase like "July 18".
 * Loose phrases without a year assume the current year (or next year if that
 * date has already passed — deadlines are forward-looking). Returns null when
 * nothing parseable is found.
 */
export function parseDateLoose(value: unknown, now: Date = new Date()): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  // Direct parse first (handles ISO and many locale formats with a year).
  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime()) && /\d{4}/.test(trimmed)) {
    return direct;
  }

  // Below here the string has no 4-digit year. Only attempt a partial-date parse
  // when it actually looks like a date — otherwise V8 leniently extracts a year
  // from junk like "whenever 2026" and returns a bogus date.
  const looksDateish =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(trimmed) ||
    /\d{1,2}[/\-.]\d{1,2}/.test(trimmed) ||
    /\d{1,2}(st|nd|rd|th)/i.test(trimmed);
  if (!looksDateish) return null;

  // No explicit year: append the current year, roll forward if already past.
  const withYear = new Date(`${trimmed} ${now.getFullYear()}`);
  if (!Number.isNaN(withYear.getTime())) {
    if (withYear.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
      const next = new Date(`${trimmed} ${now.getFullYear() + 1}`);
      if (!Number.isNaN(next.getTime())) return next;
    }
    return withYear;
  }

  return null;
}

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim().toLowerCase());
}

export function isValidInstagram(value: string): boolean {
  return normalizeInstagram(value) !== null;
}

export function isValidCurrency(value: string): boolean {
  return CURRENCY_RE.test(value.trim().toUpperCase());
}
