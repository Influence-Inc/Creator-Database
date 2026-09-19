/**
 * Pure parsing of an inbound Instagram DM into the links we care about.
 *
 * A scout sends two kinds of thing to the company account: a creator's
 * **profile** and a **reel** that creator could remake with the brand in it.
 * Both arrive as instagram.com URLs — either typed/pasted as text, or as a
 * share attachment, where Meta includes only the URL.
 *
 * Kept free of NestJS and Prisma so the classification rules can be tested
 * directly; the shape of Meta's payload is the one thing here that can't be
 * verified without a live account, so anything unrecognised is preserved rather
 * than dropped (see `otherLinks`).
 */

/** Path segments that mean "a piece of content", not "a person". */
const CONTENT_SEGMENTS = new Set(['reel', 'reels', 'p', 'tv', 'stories', 'share']);

/**
 * Path segments that are Instagram's own pages rather than a creator handle, so
 * they must never be read as a profile.
 */
const RESERVED_SEGMENTS = new Set([
  'explore',
  'accounts',
  'direct',
  'about',
  'developer',
  'legal',
  'privacy',
  'terms',
  'challenge',
  'session',
  'web',
  'api',
]);

export interface ClassifiedLinks {
  /** Canonical `https://instagram.com/<handle>` profile URLs, de-duplicated. */
  profileLinks: string[];
  /** Reel/post permalinks, de-duplicated. */
  reelLinks: string[];
  /** URLs that were shared but aren't instagram.com permalinks (e.g. a CDN
   *  media URL). Recorded so a share is never silently discarded. */
  otherLinks: string[];
}

/** Every http(s) URL in a blob of text. */
function urlsInText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi);
  return matches ? matches.map((u) => u.replace(/[.,;:!?]+$/, '')) : [];
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

function isInstagramHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return host === 'instagram.com' || host.endsWith('.instagram.com');
}

/** Handles are letters, numbers, dots and underscores, up to 30 characters. */
function isHandleLike(segment: string): boolean {
  return /^[A-Za-z0-9._]{1,30}$/.test(segment);
}

export interface LinkClassification {
  kind: 'profile' | 'reel' | 'other';
  /** Canonical URL to store. */
  url: string;
  /** Present for profiles. */
  handle?: string;
}

/**
 * Decide what a single URL is.
 *
 * `instagram.com/<handle>`            -> profile
 * `instagram.com/reel|reels|p|tv/...` -> reel (a post counts: it's still the
 *                                        content to remake)
 * `instagram.com/<handle>/reel/<id>`  -> reel, since the content is the
 *                                        specific thing being pointed at
 * anything else                        -> other
 */
export function classifyLink(raw: string): LinkClassification {
  const url = parseUrl(raw);
  if (!url || !isInstagramHost(url)) {
    return { kind: 'other', url: raw.trim() };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return { kind: 'other', url: url.toString() };

  const first = segments[0].toLowerCase();

  // /reel/<id>, /p/<id>, /tv/<id>, /stories/<user>/<id>
  if (CONTENT_SEGMENTS.has(first)) {
    return { kind: 'reel', url: stripQuery(url) };
  }

  // /<handle>/reel/<id> — the content is what's being shared, not the person.
  if (segments.length >= 2 && CONTENT_SEGMENTS.has(segments[1].toLowerCase())) {
    return { kind: 'reel', url: stripQuery(url) };
  }

  if (RESERVED_SEGMENTS.has(first) || !isHandleLike(segments[0])) {
    return { kind: 'other', url: url.toString() };
  }

  // A bare handle.
  const handle = segments[0].toLowerCase();
  return { kind: 'profile', url: `https://instagram.com/${handle}`, handle };
}

/** Drop tracking query strings (`?igsh=…`) but keep the path. */
function stripQuery(url: URL): string {
  return `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

function pushUnique(list: string[], value: string): void {
  if (value && list.indexOf(value) < 0) list.push(value);
}

/**
 * Classify every URL carried by a message — from its text and from any share
 * attachments.
 */
export function classifyMessageLinks(input: {
  text?: string | null;
  attachmentUrls?: string[];
}): ClassifiedLinks {
  const out: ClassifiedLinks = { profileLinks: [], reelLinks: [], otherLinks: [] };

  const candidates = [
    ...urlsInText(input.text ?? ''),
    ...(input.attachmentUrls ?? []).filter(Boolean),
  ];

  for (const candidate of candidates) {
    const classified = classifyLink(candidate);
    if (classified.kind === 'profile') pushUnique(out.profileLinks, classified.url);
    else if (classified.kind === 'reel') pushUnique(out.reelLinks, classified.url);
    else pushUnique(out.otherLinks, classified.url);
  }

  return out;
}

/** Every URL Meta attached to a message, whatever the attachment type. */
export function attachmentUrls(message: Record<string, unknown>): string[] {
  const attachments = message?.attachments;
  // Webhooks send a plain array; the Conversations API wraps it in `{ data: [] }`.
  const nested =
    attachments && typeof attachments === 'object'
      ? (attachments as { data?: unknown }).data
      : undefined;
  const list: unknown[] = Array.isArray(attachments)
    ? attachments
    : Array.isArray(nested)
      ? nested
      : [];

  const urls: string[] = [];
  for (const raw of list) {
    const att = (raw ?? {}) as Record<string, unknown>;
    const payload = (att.payload ?? {}) as Record<string, unknown>;
    for (const key of ['url', 'title', 'permalink_url']) {
      const value = payload[key];
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) pushUnique(urls, value);
    }
  }
  return urls;
}
