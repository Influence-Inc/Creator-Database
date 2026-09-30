/**
 * Pure parsing of an inbound Instagram DM into the links we care about.
 *
 * A scout sends two kinds of thing to the company account: a creator's
 * **profile** and a **reel** that creator could remake with the brand in it.
 * They normally arrive as share attachments (Instagram's Share button), which
 * are read by attachment type — see `sharedItems`. Links typed or pasted as
 * text are still understood, by URL.
 *
 * Kept free of NestJS and Prisma so the classification rules can be tested
 * directly. Anything unrecognised is preserved rather than dropped (see
 * `otherLinks`).
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
 * One thing a scout shared with Instagram's Share button, read from the
 * attachment itself rather than from its URL.
 *
 * This is the distinction the whole integration hinges on. Meta never puts an
 * instagram.com permalink on a share: a shared reel or post arrives as an
 * `ig_reel` / `ig_post` / `share` attachment whose `url` is a temporary media
 * link on `lookaside.fbsbx.com` ("Only the image or video URL for a share will
 * be included"). Classifying by host alone therefore threw every share away.
 * The attachment's *type* is what says "this is a reel" — so that's what's read.
 */
export interface SharedItem {
  kind: 'reel' | 'profile' | 'unknown';
  /** Attachment type as Meta labelled it, or where it came from in the API. */
  source: string;
  /** Link to store: a canonical instagram.com URL — sent by Meta, or rebuilt
   *  from the media id (see `permalinkFor`) — falling back to the media URL
   *  Meta sent when neither is possible. */
  url: string | null;
  /** The URL exactly as Meta sent it — for a share, a `lookaside.fbsbx.com`
   *  media link that expires after a few days. */
  mediaUrl: string | null;
  /** Meta's id for the shared media (`reel_video_id` / post `id`). Kept
   *  because the media URL expires and this does not. */
  mediaId: string | null;
  /** Caption / name Meta attached to the share, if any. */
  title: string | null;
  /** Creator handle, for profile shares. */
  handle: string | null;
}

/** Attachment types that carry a piece of content to remake. */
const REEL_TYPES = new Set([
  'ig_reel',
  'reel',
  'ig_post',
  'post',
  'share',
  'ig_clip',
  'clip',
  'igtv',
]);

/** Attachment types that carry a person rather than content. Meta doesn't
 *  document a profile share, so this is deliberately broad. */
function isProfileType(type: string): boolean {
  return type === 'ig_profile' || type === 'profile' || type === 'user' || /profile/.test(type);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function httpUrl(value: unknown): string | null {
  const s = str(value);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

function idString(value: unknown): string | null {
  // A number past 2^53 was already rounded by JSON.parse; its digits are no
  // longer the id, and a media pk is always that large. Refuse it rather than
  // rebuild a link from the wrong number.
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  return str(value);
}

/** A handle from wherever Meta might put one on a profile share. */
function handleFrom(...values: unknown[]): string | null {
  for (const value of values) {
    const s = str(value)?.replace(/^@/, '');
    if (s && isHandleLike(s)) return s.toLowerCase();
  }
  return null;
}

/**
 * Read one share, whatever shape it came in.
 *
 * `type` is the attachment type when Meta gave one (webhooks always do; the
 * Conversations API doesn't, so the caller passes where it found the item).
 */
function toSharedItem(
  type: string,
  fields: { url: string | null; mediaId: string | null; title: string | null; username?: unknown },
  assumeContent: boolean,
): SharedItem {
  const base = { source: type, mediaUrl: fields.url, mediaId: fields.mediaId, title: fields.title };

  // An actual instagram.com link settles it, whatever the type says.
  if (fields.url) {
    const classified = classifyLink(fields.url);
    if (classified.kind === 'profile') {
      return { ...base, kind: 'profile', url: classified.url, handle: classified.handle ?? null };
    }
    if (classified.kind === 'reel') {
      return { ...base, kind: 'reel', url: classified.url, handle: null };
    }
  }

  if (isProfileType(type)) {
    // A profile is only useful with a handle — that's what the sheet keys on.
    const handle = handleFrom(fields.username, fields.title);
    return handle
      ? { ...base, kind: 'profile', url: `https://instagram.com/${handle}`, handle }
      : { ...base, kind: 'unknown', url: fields.url, handle: null };
  }

  if ((REEL_TYPES.has(type) || assumeContent) && fields.url) {
    // Meta only sends an expiring media link; swap in the permanent one when
    // the media id allows it.
    const permalink = permalinkFor(type, fields.mediaId, fields.url);
    return { ...base, kind: 'reel', url: permalink ?? fields.url, handle: null };
  }

  return { ...base, kind: 'unknown', url: fields.url, handle: null };
}

/** The alphabet Instagram writes shortcodes in: base 64, most significant first. */
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 10^18: every Instagram media pk since ~2015 is at least 19 digits. */
const MIN_MEDIA_PK = BigInt('1000000000000000000');

/**
 * The shortcode in `instagram.com/reel/<shortcode>` for an Instagram media pk.
 *
 * A shortcode is just the media's internal number (its "pk") written in base
 * 64, so it can be rebuilt exactly — but ONLY from a pk. Meta has other ids for
 * the same media: Graph API media ids are 17 digits and Facebook video ids are
 * 15–16, and encoding either yields a well-formed shortcode for some other post
 * or none at all. Those are told apart by size: anything under 19 digits is
 * refused rather than turned into a link that looks right but isn't.
 *
 * Takes a string, never a number: pks exceed 2^53, so a pk that went through
 * a JSON number has already lost its low digits.
 */
export function shortcodeFromMediaId(id: string | null | undefined): string | null {
  if (typeof id !== 'string') return null;
  // Some surfaces write "<pk>_<owner id>"; the shortcode is the pk alone.
  const pk = id.trim().split('_')[0];
  if (!/^\d{19,20}$/.test(pk)) return null;

  let n = BigInt(pk);
  if (n < MIN_MEDIA_PK) return null;
  let code = '';
  while (n > BigInt(0)) {
    code = SHORTCODE_ALPHABET[Number(n % BigInt(64))] + code;
    n /= BigInt(64);
  }
  return code;
}

/** The `asset_id` on a `lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=…` link. */
function assetIdFrom(url: string | null): string | null {
  const parsed = url ? parseUrl(url) : null;
  if (!parsed || !/(^|\.)fbsbx\.com$/i.test(parsed.hostname)) return null;
  return parsed.searchParams.get('asset_id');
}

/**
 * The permanent instagram.com link for a share, or null when it can't be
 * rebuilt with certainty (see `shortcodeFromMediaId`).
 *
 * Tries the id Meta named on the attachment (`reel_video_id` / post `id`),
 * then the `asset_id` on the media link. Reels get `/reel/`, everything else
 * `/p/` — Instagram serves any media on either path.
 */
export function permalinkFor(
  type: string,
  mediaId: string | null,
  mediaUrl: string | null,
): string | null {
  const code = shortcodeFromMediaId(mediaId) ?? shortcodeFromMediaId(assetIdFrom(mediaUrl));
  if (!code) return null;
  const path = type === 'ig_reel' || type === 'reel' || type === 'ig_clip' ? 'reel' : 'p';
  return `https://www.instagram.com/${path}/${code}`;
}

/** The list form of a field that webhooks send bare and the API wraps in `{ data }`. */
function listOf(value: unknown): Record<string, unknown>[] {
  const nested =
    value && typeof value === 'object' ? (value as { data?: unknown }).data : undefined;
  const list = Array.isArray(value) ? value : Array.isArray(nested) ? nested : [];
  return list.map((item) => (item ?? {}) as Record<string, unknown>);
}

/**
 * Every share on a message — from a webhook (`attachments[].{type,payload}`)
 * or from the Conversations API (`attachments.data[].{video_data,image_data,
 * file_url}` plus `shares.data[].link`).
 */
export function sharedItems(message: Record<string, unknown> | null | undefined): SharedItem[] {
  if (!message || typeof message !== 'object') return [];
  const out: SharedItem[] = [];

  for (const att of listOf(message.attachments)) {
    const type = (str(att.type) ?? '').toLowerCase();
    const payload = (att.payload ?? null) as Record<string, unknown> | null;

    if (payload && typeof payload === 'object') {
      // Webhook shape.
      out.push(
        toSharedItem(
          type,
          {
            url: httpUrl(payload.url) ?? httpUrl(payload.permalink_url) ?? httpUrl(payload.link),
            mediaId:
              idString(payload.reel_video_id) ?? idString(payload.id) ?? idString(payload.media_id),
            title: str(payload.title),
            username: payload.username ?? payload.handle,
          },
          false,
        ),
      );
      continue;
    }

    // Conversations API shape: no type, no payload. Meta says a share comes
    // back as just its image or video URL, so video/image media is read as
    // the shared content.
    const video = httpUrl((att.video_data as Record<string, unknown> | undefined)?.url);
    const image = httpUrl((att.image_data as Record<string, unknown> | undefined)?.url);
    const file = httpUrl(att.file_url);
    const url = video ?? image ?? file;
    if (!url && !type) continue;
    out.push(
      toSharedItem(
        type || (video ? 'video' : image ? 'image' : 'file'),
        // `att.id` is the attachment's own id, not the shared media's, so it
        // is never used to rebuild a link; the media URL's asset_id is.
        { url, mediaId: null, title: str(att.name) },
        !!(video || image),
      ),
    );
  }

  // The Conversations API reports shared posts under `shares`. Their `id` is
  // likewise not documented as the media's, so only the link is relied on.
  for (const share of listOf(message.shares)) {
    out.push(
      toSharedItem(
        'shares',
        {
          url: httpUrl(share.link) ?? httpUrl(share.url),
          mediaId: null,
          title: str(share.name) ?? str(share.description),
        },
        true,
      ),
    );
  }

  return out;
}

/**
 * The message node inside a stored payload. Webhook rows keep the whole event
 * (`{ sender, message: { mid, attachments } }`); rows read from the inbox keep
 * the message itself, where `message` is just the text.
 */
export function messageNode(raw: unknown): Record<string, unknown> {
  const event = (raw ?? {}) as Record<string, unknown>;
  const inner = event.message;
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : event;
}

/**
 * Classify everything a message carries: links typed or pasted into the text,
 * and — the main path — what was shared with the Share button.
 *
 * `shares` is read by attachment type (see `SharedItem`). `attachmentUrls` is
 * the older, URL-only input, still accepted for callers that have nothing else.
 */
export function classifyMessageLinks(input: {
  text?: string | null;
  attachmentUrls?: string[];
  shares?: SharedItem[];
}): ClassifiedLinks {
  const out: ClassifiedLinks = { profileLinks: [], reelLinks: [], otherLinks: [] };

  for (const share of input.shares ?? []) {
    if (share.kind === 'profile' && share.url) pushUnique(out.profileLinks, share.url);
    else if (share.kind === 'reel' && share.url) pushUnique(out.reelLinks, share.url);
    else if (share.url) pushUnique(out.otherLinks, share.url);
  }

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

/** Every URL Meta attached to a message, whatever the attachment type or shape. */
export function attachmentUrls(message: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const att of listOf(message?.attachments)) {
    const payload = (att.payload ?? {}) as Record<string, unknown>;
    for (const key of ['url', 'title', 'permalink_url']) {
      const value = payload[key];
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) pushUnique(urls, value);
    }
    // Conversations API attachments carry their media under these instead.
    for (const value of [
      (att.video_data as Record<string, unknown> | undefined)?.url,
      (att.image_data as Record<string, unknown> | undefined)?.url,
      att.file_url,
    ]) {
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) pushUnique(urls, value);
    }
  }
  for (const share of listOf(message?.shares)) {
    const link = httpUrl(share.link) ?? httpUrl(share.url);
    if (link) pushUnique(urls, link);
  }
  return urls;
}
