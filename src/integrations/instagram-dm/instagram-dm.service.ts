import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InstagramMessageStatus, Prisma, ScoutEntry, User } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { normalizeInstagram } from '../../common/utils/normalize';
import {
  attachmentUrls,
  classifyLink,
  classifyMessageLinks,
  messageNode,
  SharedItem,
  sharedItems,
} from './instagram-links';
import { InstagramGraphService } from './instagram-graph.service';

/** One message lifted out of a webhook payload. */
export interface InboundMessage {
  messageId: string;
  senderId: string;
  text?: string | null;
  attachmentUrls: string[];
  /** What was shared with the Share button, read by attachment type. When
   *  present this — not `attachmentUrls` — decides what gets filed. */
  shares?: SharedItem[];
  raw: unknown;
}

export interface IngestOutcome {
  status: InstagramMessageStatus;
  note?: string;
  entryId?: string | null;
}

/** Graph API version the diagnosis pins its probes to. */
export const DIAGNOSE_GRAPH_VERSION = 'v23.0';

/** One way of asking Meta for the inbox, and what came back. */
export interface InboxProbe {
  label: string;
  ok: boolean;
  conversations: number;
  /** Other people in those conversations, as @usernames. */
  participants: string[];
  error?: string;
}

export interface InstagramDiagnosis {
  account:
    | { ok: true; username: string | null; accountType: string | null; userId: string | null }
    | { ok: false; error: string };
  inbox: InboxProbe[];
  webhookSubscription: { ok: true; fields: string[] } | { ok: false; error: string };
  webhook: {
    /** Recorded webhook calls — only rejected or empty ones are logged here. */
    deliveries: number;
    /** Messages stored from either route, webhook or inbox read. */
    storedMessages: number;
    lastDelivery: { at: Date; outcome: string; detail: string | null } | null;
  };
  /** Plain-English findings, most important first. */
  verdict: string[];
}

/** Turn the diagnosis findings into sentences an admin can act on. */
export function diagnosisVerdict(
  account: InstagramDiagnosis['account'],
  inbox: InboxProbe[],
  subscription: InstagramDiagnosis['webhookSubscription'],
  webhook: InstagramDiagnosis['webhook'],
): string[] {
  if (!account.ok) {
    return [
      `Meta rejected the access token: "${account.error}". In Meta's dashboard click Generate token on the influence__inc row, and replace INSTAGRAM_ACCESS_TOKEN in Railway with it.`,
    ];
  }

  const out: string[] = [];
  const who = account.username ? `@${account.username}` : 'the connected account';

  if (account.accountType && !['BUSINESS', 'MEDIA_CREATOR'].includes(account.accountType)) {
    out.push(
      `${who} is not a professional account (Meta reports "${account.accountType}"). DMs can only be read on a Business or Creator account.`,
    );
  }

  const current = inbox[0];
  const found = inbox.find((p) => p.ok && p.conversations > 0);
  const failed = inbox.filter((p) => !p.ok);
  if (found && !(current?.ok && current.conversations > 0)) {
    out.push(
      `Meta DOES return ${found.conversations} conversation(s) when asked ${found.label}, but not ${current?.label ?? 'the way the app asks'}. That is a problem in our app, not your setup — send this to the developer.`,
    );
  } else if (found) {
    out.push(
      `Meta shows ${found.conversations} conversation(s)${found.participants.length ? ` with ${found.participants.join(', ')}` : ''}. Reading the inbox works.`,
    );
  } else if (inbox.length > 0 && failed.length === inbox.length) {
    const error = failed[0].error ?? 'unknown error';
    out.push(
      `Meta refused to read ${who}'s inbox: "${error}".` +
        (/permission|capabilit|scope/i.test(error)
          ? ' The token is missing the messaging permission: add instagram_business_manage_messages to the app (Meta dashboard → Use cases → Customize), then generate a new token.'
          : ''),
    );
  } else {
    out.push(
      `Meta shows this app an EMPTY inbox for ${who}, however it is asked. That is decided on Meta's side — no Railway, webhook or redirect setting changes it.`,
    );
    out.push(
      `The usual reasons Meta hides DMs from an app: (1) the sender's Instagram Tester invite was never accepted — assigning the role only sends an invite; the sender must log in on instagram.com in a browser → Settings → Apps and websites → Tester invites → Accept; (2) the app's Instagram use case lacks the instagram_business_manage_messages permission (Meta dashboard → Use cases → Customize); (3) "Allow access to messages" is off on ${who}.`,
    );
  }

  if (subscription.ok && !subscription.fields.includes('messages')) {
    out.push(
      `${who} is not subscribed to message webhooks (subscribed: ${subscription.fields.join(', ') || 'nothing'}). In Meta's dashboard, step 2, turn Webhook Subscription On for ${who}.`,
    );
  }

  if (webhook.deliveries === 0 && webhook.storedMessages === 0) {
    out.push('Meta has never called the webhook, and no message has ever been stored.');
  } else if (webhook.lastDelivery) {
    out.push(
      `The last webhook call that was turned away or empty ended "${webhook.lastDelivery.outcome}"${webhook.lastDelivery.detail ? ` — ${webhook.lastDelivery.detail}` : ''}. ${webhook.storedMessages} message(s) stored in total.`,
    );
  } else {
    out.push(`${webhook.storedMessages} message(s) stored in total.`);
  }

  return out;
}

/**
 * Files Instagram DMs onto the sending scout's sheet.
 *
 * The flow a scout follows is: send the creator's profile, then send the reel
 * that creator could remake with the brand in it. Those are two separate
 * messages that have to end up on ONE row, and they can arrive in either order,
 * so pairing is the real work here:
 *
 *   profile arrives -> fill the newest row that has a reel but no profile,
 *                      otherwise start a new row
 *   reel arrives    -> fill the newest row that has a profile but no reel,
 *                      otherwise start a new row with the profile left blank
 *
 * Pairing only considers rows created inside a time window (default 24h), so a
 * long-abandoned half-filled row can't silently capture next week's reel. A
 * completely blank row — one a scout added by hand and hasn't typed into — is
 * matched by neither rule, so manual work is never hijacked.
 */
@Injectable()
export class InstagramDmService {
  private readonly logger = new Logger(InstagramDmService.name);

  /** The connected account itself, cached after the first successful lookup. */
  private businessAccount: { id: string; username: string } | null = null;

  /** When the inbox was last polled, and what it found. */
  private lastInboxSync: { at: Date; detail: string } | null = null;

  /**
   * Record how a webhook delivery ended, whatever the outcome.
   *
   * Written to the database rather than held in memory. Rejected deliveries
   * leave no `InstagramMessage` row, so this is the only evidence that Meta
   * reached us at all — and an in-memory copy was wiped by every redeploy,
   * which made "Meta has never called" and "Meta called before the last
   * deploy" both read as null. That ambiguity is precisely what this is for.
   *
   * Deliberately fire-and-forget: a diagnostic write must never be able to
   * fail the webhook itself, because Meta retries anything that isn't a 200.
   */
  recordDelivery(outcome: string, detail?: string): void {
    void this.prisma.instagramWebhookDelivery
      ?.create({ data: { outcome, detail: detail ?? null } })
      .catch((err: unknown) => {
        this.logger.warn(
          `Could not record webhook delivery: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly graph: InstagramGraphService,
  ) {}

  private pairWindowMs(): number {
    const hours = this.config.get<number>('instagramDm.pairWindowHours') ?? 24;
    return Math.max(1, hours) * 3600 * 1000;
  }

  // -------------------------------------------------------------------------
  // Sender -> scout
  // -------------------------------------------------------------------------

  /**
   * Find the scout who sent a message. The Instagram-scoped id is cached on the
   * user the first time we place them, so the Graph lookup happens once per
   * scout rather than once per message.
   */
  async resolveScout(senderId: string): Promise<{ scout: User | null; username: string | null }> {
    const cached = await this.prisma.user.findFirst({ where: { instagramUserId: senderId } });
    if (cached) return { scout: cached, username: cached.instagramHandle };

    const username = await this.graph.lookupUsername(senderId);
    if (!username) return { scout: null, username: null };

    const scout = await this.prisma.user.findFirst({
      where: { instagramHandle: username, isActive: true },
    });
    if (!scout) return { scout: null, username };

    // Remember the id so later messages skip the lookup entirely.
    try {
      const updated = await this.prisma.user.update({
        where: { id: scout.id },
        data: { instagramUserId: senderId },
      });
      return { scout: updated, username };
    } catch {
      // Another message for the same scout may have cached it concurrently.
      return { scout, username };
    }
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  private cutoff(): Date {
    return new Date(Date.now() - this.pairWindowMs());
  }

  /** Newest row that has a reel but is still missing its profile. */
  private findReelOnlyRow(scoutId: string): Promise<ScoutEntry | null> {
    return this.prisma.scoutEntry.findFirst({
      where: {
        scoutId,
        instagramProfileLink: '',
        NOT: [{ reelIdeas: null }, { reelIdeas: '' }],
        createdAt: { gte: this.cutoff() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Newest row that has a profile but is still missing its reel. */
  private findProfileOnlyRow(scoutId: string): Promise<ScoutEntry | null> {
    return this.prisma.scoutEntry.findFirst({
      where: {
        scoutId,
        NOT: { instagramProfileLink: '' },
        OR: [{ reelIdeas: null }, { reelIdeas: '' }],
        createdAt: { gte: this.cutoff() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Append a row to a scout's sheet, numbered sequentially within that sheet. */
  private async createRow(
    scoutId: string,
    data: {
      instagramProfileLink: string;
      instagramUsername?: string | null;
      reelIdeas?: string | null;
    },
  ): Promise<ScoutEntry> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const last = await this.prisma.scoutEntry.findFirst({
        where: { scoutId },
        orderBy: { rowNumber: 'desc' },
        select: { rowNumber: true },
      });
      try {
        return await this.prisma.scoutEntry.create({
          data: {
            scoutId,
            rowNumber: (last?.rowNumber ?? 0) + 1,
            instagramProfileLink: data.instagramProfileLink,
            instagramUsername: data.instagramUsername ?? null,
            reelIdeas: data.reelIdeas ?? null,
          },
        });
      } catch (err) {
        const clash = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (!clash || attempt === 3) throw err;
      }
    }
    throw new Error('Could not allocate a row number for the incoming message');
  }

  /** File a profile link: fill a waiting reel-only row, else start a new row. */
  private async applyProfile(scoutId: string, profileUrl: string): Promise<ScoutEntry> {
    const handle = normalizeInstagram(profileUrl);
    const waiting = await this.findReelOnlyRow(scoutId);
    if (waiting) {
      return this.prisma.scoutEntry.update({
        where: { id: waiting.id },
        data: { instagramProfileLink: profileUrl, instagramUsername: handle },
      });
    }
    return this.createRow(scoutId, { instagramProfileLink: profileUrl, instagramUsername: handle });
  }

  /** File a reel link: fill a waiting profile-only row, else start a new row. */
  private async applyReel(scoutId: string, reelUrl: string): Promise<ScoutEntry> {
    const waiting = await this.findProfileOnlyRow(scoutId);
    if (waiting) {
      return this.prisma.scoutEntry.update({
        where: { id: waiting.id },
        data: { reelIdeas: reelUrl },
      });
    }
    // Reel first: the row appears with an empty profile until one arrives.
    return this.createRow(scoutId, { instagramProfileLink: '', reelIdeas: reelUrl });
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  /**
   * Process one inbound message. Safe to call twice with the same message —
   * Meta retries webhooks, and `messageId` is unique, so a redelivery is
   * recognised and skipped rather than filing the same share again.
   */
  async ingest(msg: InboundMessage): Promise<IngestOutcome> {
    const seen = await this.prisma.instagramMessage.findUnique({
      where: { messageId: msg.messageId },
      select: { id: true, status: true, entryId: true },
    });
    if (seen) {
      this.logger.debug(`Ignoring duplicate Instagram message ${msg.messageId}`);
      return { status: seen.status, note: 'duplicate delivery', entryId: seen.entryId };
    }

    // Shares are read by attachment type; their raw URLs are never re-read by
    // host as well, or each share would also land in `otherLinks`.
    const links = classifyMessageLinks(
      msg.shares
        ? { text: msg.text, shares: msg.shares }
        : { text: msg.text, attachmentUrls: msg.attachmentUrls },
    );
    const record = {
      messageId: msg.messageId,
      senderId: msg.senderId,
      text: msg.text ?? null,
      profileLinks: links.profileLinks,
      reelLinks: links.reelLinks,
      otherLinks: links.otherLinks,
      raw: (msg.raw ?? null) as Prisma.InputJsonValue,
    };

    const hasLinks = links.profileLinks.length > 0 || links.reelLinks.length > 0;

    const { scout, username } = await this.resolveScout(msg.senderId);
    if (!scout) {
      const note = username
        ? `No active scout has the Instagram handle @${username}`
        : 'Could not identify the sender — set the scout’s Instagram handle, or add an access token so usernames can be resolved';
      await this.prisma.instagramMessage.create({
        data: {
          ...record,
          senderUsername: username,
          status: InstagramMessageStatus.UNMATCHED_SENDER,
          statusNote: note,
        },
      });
      this.logger.warn(
        `Instagram message from ${username ? '@' + username : msg.senderId} did not match a scout`,
      );
      return { status: InstagramMessageStatus.UNMATCHED_SENDER, note };
    }

    if (!hasLinks) {
      // Meta flags content it won't pass through (it has no documented profile
      // share, for one) as unsupported. Say so, rather than implying the scout
      // sent nothing useful.
      const unsupported = messageNode(msg.raw).is_unsupported === true;
      const unknownShare = (msg.shares ?? []).find((s) => s.kind === 'unknown');
      await this.prisma.instagramMessage.create({
        data: {
          ...record,
          senderUsername: username ?? scout.instagramHandle,
          scoutId: scout.id,
          status: InstagramMessageStatus.NO_LINKS,
          statusNote: unsupported
            ? 'Instagram delivered this share as unsupported content, with no link or details to file'
            : unknownShare
              ? `Shared a "${unknownShare.source}" attachment, which is not a reel, post or profile`
              : links.otherLinks.length
                ? 'Shared something that is not an Instagram profile or reel link'
                : 'No Instagram links in the message',
        },
      });
      return { status: InstagramMessageStatus.NO_LINKS };
    }

    try {
      // Profiles first: when one message carries both, the profile makes the
      // row and the reel then lands on that same row.
      let entry: ScoutEntry | null = null;
      for (const profile of links.profileLinks) entry = await this.applyProfile(scout.id, profile);
      for (const reel of links.reelLinks) entry = await this.applyReel(scout.id, reel);

      await this.prisma.instagramMessage.create({
        data: {
          ...record,
          senderUsername: username ?? scout.instagramHandle,
          scoutId: scout.id,
          entryId: entry?.id ?? null,
          status: InstagramMessageStatus.APPLIED,
        },
      });

      this.logger.log(
        `Filed Instagram message from @${username ?? scout.instagramHandle} onto row ${entry?.rowNumber}`,
      );
      return { status: InstagramMessageStatus.APPLIED, entryId: entry?.id ?? null };
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      await this.prisma.instagramMessage.create({
        data: {
          ...record,
          senderUsername: username ?? scout.instagramHandle,
          scoutId: scout.id,
          status: InstagramMessageStatus.FAILED,
          statusNote: note,
        },
      });
      this.logger.error('Failed to file an Instagram message', { error: note });
      return { status: InstagramMessageStatus.FAILED, note };
    }
  }

  /** Pull every message out of a webhook payload, whatever its nesting. */
  extractMessages(payload: unknown): InboundMessage[] {
    const out: InboundMessage[] = [];
    const body = (payload ?? {}) as Record<string, unknown>;
    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries as Array<Record<string, unknown>>) {
      // Messages arrive under `messaging`; some subscriptions wrap the same
      // shape in `changes[].value` instead, so both are accepted.
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      const events: unknown[] = Array.isArray(entry.messaging)
        ? entry.messaging
        : changes
            .map((change) => (change as { value?: unknown } | null)?.value)
            .filter((value): value is unknown => !!value);

      for (const rawEvent of events) {
        const event = (rawEvent ?? {}) as Record<string, unknown>;
        const message = (event.message ?? {}) as Record<string, unknown>;
        const messageId = typeof message.mid === 'string' ? message.mid : null;
        const sender = (event.sender ?? {}) as { id?: unknown };
        const senderId = typeof sender.id === 'string' ? sender.id : null;

        // Echoes are our own outgoing messages coming back; ignore them.
        if (!messageId || !senderId || message.is_echo === true) continue;
        if (message.is_deleted === true) continue;

        out.push({
          messageId,
          senderId,
          text: typeof message.text === 'string' ? message.text : null,
          attachmentUrls: attachmentUrls(message),
          shares: sharedItems(message),
          raw: event,
        });
      }
    }
    return out;
  }

  /**
   * Point an Instagram sender id at a scout and re-file everything of theirs
   * that's been sitting unmatched.
   *
   * Shared by both routes into this: a scout claiming their own handle, and an
   * admin resolving a sender by hand. Messages already waiting are processed as
   * if they'd just arrived, so nothing has to be sent again.
   */
  private async relinkAndReprocess(
    senderId: string,
    scoutId: string,
    adoptUsername?: string | null,
  ) {
    const scout = await this.prisma.user.findUnique({ where: { id: scoutId } });
    if (!scout) throw new Error('Scout not found');

    // An Instagram id belongs to exactly one scout; release it from whoever
    // held it before rather than failing on the unique constraint.
    await this.prisma.user.updateMany({
      where: { instagramUserId: senderId, NOT: { id: scoutId } },
      data: { instagramUserId: null },
    });
    await this.prisma.user.update({
      where: { id: scoutId },
      data: {
        instagramUserId: senderId,
        ...(scout.instagramHandle || !adoptUsername ? {} : { instagramHandle: adoptUsername }),
      },
    });

    const pending = await this.prisma.instagramMessage.findMany({
      where: { senderId, status: InstagramMessageStatus.UNMATCHED_SENDER },
      orderBy: { receivedAt: 'asc' },
    });

    let filed = 0;
    for (const row of pending) {
      const node = messageNode(row.raw);
      // Clear the old ledger row so ingest doesn't treat this as a duplicate.
      await this.prisma.instagramMessage.delete({ where: { id: row.id } });
      const outcome = await this.ingest({
        messageId: row.messageId,
        senderId: row.senderId,
        text: row.text,
        attachmentUrls: attachmentUrls(node),
        shares: sharedItems(node),
        raw: row.raw,
      });
      if (outcome.status === InstagramMessageStatus.APPLIED) filed += 1;
    }

    this.logger.log(
      `Linked Instagram sender ${senderId} to scout ${scout.username}; re-filed ${filed} message(s)`,
    );
    return { linked: true as const, scoutId, reprocessed: pending.length, filed };
  }

  /**
   * Re-file shares that were dropped as "no links" before shares were read by
   * attachment type.
   *
   * Until then a reel or post sent with the Share button was judged by its URL,
   * and since Meta only ever sends a `lookaside.fbsbx.com` media URL for a
   * share, every one was recorded as NO_LINKS. The verbatim payload was kept on
   * each of those rows, so they can be read again now and put on the scout's
   * sheet without anyone resending them.
   *
   * Only rows that now yield a reel or profile are touched; a message that
   * genuinely had nothing in it stays as it was. Safe to run repeatedly — a
   * refiled message is APPLIED and never picked up here again.
   */
  async refileDroppedShares(limit = 500): Promise<{ checked: number; refiled: number }> {
    const rows = await this.prisma.instagramMessage.findMany({
      where: { status: InstagramMessageStatus.NO_LINKS },
      // Oldest first, so a profile and reel sent in that order still pair.
      orderBy: { receivedAt: 'asc' },
      take: limit,
    });

    let refiled = 0;
    for (const row of rows) {
      const node = messageNode(row.raw);
      const shares = sharedItems(node);
      const links = classifyMessageLinks({ text: row.text, shares });
      if (links.profileLinks.length === 0 && links.reelLinks.length === 0) continue;

      try {
        // Clear the old ledger row so ingest doesn't treat this as a duplicate.
        await this.prisma.instagramMessage.delete({ where: { id: row.id } });
        const outcome = await this.ingest({
          messageId: row.messageId,
          senderId: row.senderId,
          text: row.text,
          attachmentUrls: attachmentUrls(node),
          shares,
          raw: row.raw,
        });
        if (outcome.status === InstagramMessageStatus.APPLIED) refiled += 1;
      } catch (err) {
        this.logger.error(
          `Could not re-file Instagram message ${row.messageId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (refiled > 0) {
      this.logger.log(`Re-filed ${refiled} earlier Instagram share(s) onto scout sheets`);
    }
    return { checked: rows.length, refiled };
  }

  /**
   * Replace expiring media links on already-filed rows with permanent
   * instagram.com links.
   *
   * Shares filed before the media id was converted (see `permalinkFor`) put
   * Meta's `lookaside.fbsbx.com` link on the sheet, which stops working after a
   * few days. The stored payload still carries the id, so the permanent link
   * can be rebuilt now.
   *
   * A sheet cell is only rewritten while it still holds that exact media link:
   * if a scout has since typed something else there, their edit stands. Shares
   * whose id can't be converted keep their media link. Safe to run repeatedly.
   */
  async upgradeReelLinks(limit = 1000): Promise<{ checked: number; upgraded: number }> {
    const rows = await this.prisma.instagramMessage.findMany({
      where: { status: InstagramMessageStatus.APPLIED, entryId: { not: null } },
      orderBy: { receivedAt: 'desc' },
      take: limit,
      select: { id: true, raw: true, reelLinks: true, entryId: true },
    });

    let checked = 0;
    let upgraded = 0;
    for (const row of rows) {
      // Anything that isn't an instagram.com link is an expiring media URL.
      const expiring = row.reelLinks.filter((url) => classifyLink(url).kind === 'other');
      if (expiring.length === 0 || !row.entryId) continue;
      checked += 1;

      const swaps = new Map<string, string>();
      for (const share of sharedItems(messageNode(row.raw))) {
        if (
          share.kind === 'reel' &&
          share.mediaUrl &&
          share.url &&
          share.url !== share.mediaUrl &&
          expiring.includes(share.mediaUrl)
        ) {
          swaps.set(share.mediaUrl, share.url);
        }
      }
      if (swaps.size === 0) continue;

      try {
        const entry = await this.prisma.scoutEntry.findUnique({
          where: { id: row.entryId },
          select: { reelIdeas: true },
        });
        const next = entry?.reelIdeas ? swaps.get(entry.reelIdeas) : undefined;
        if (next) {
          await this.prisma.scoutEntry.update({
            where: { id: row.entryId },
            data: { reelIdeas: next },
          });
          upgraded += 1;
        }
        // Keep the message log in step, so this row isn't checked again.
        await this.prisma.instagramMessage.update({
          where: { id: row.id },
          data: { reelLinks: row.reelLinks.map((url) => swaps.get(url) ?? url) },
        });
      } catch (err) {
        this.logger.error(
          `Could not upgrade the reel link for Instagram message ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (upgraded > 0) {
      this.logger.log(
        `Replaced ${upgraded} expiring reel link(s) with permanent instagram.com links`,
      );
    }
    return { checked, upgraded };
  }

  /** Admin path: resolve one unplaced message to a scout. */
  async assignSender(messageId: string, scoutId: string) {
    const message = await this.prisma.instagramMessage.findUnique({ where: { id: messageId } });
    if (!message) throw new Error('Message not found');
    return this.relinkAndReprocess(message.senderId, scoutId, message.senderUsername);
  }

  /**
   * Self-service path: a scout has just told us their Instagram handle, so
   * adopt anything already waiting from that username.
   *
   * This is what makes setting your own handle retroactive — send links first,
   * set the handle afterwards, and the links still land on your sheet without
   * anyone having to intervene.
   */
  async claimForScout(scoutId: string): Promise<{ reprocessed: number; filed: number }> {
    const scout = await this.prisma.user.findUnique({ where: { id: scoutId } });
    if (!scout?.instagramHandle) return { reprocessed: 0, filed: 0 };

    const handle = scout.instagramHandle;
    const waiting = await this.prisma.instagramMessage.findMany({
      where: {
        status: InstagramMessageStatus.UNMATCHED_SENDER,
        // Either we already know who sent it, or we never managed to resolve
        // them — those are re-checked below rather than written off.
        OR: [{ senderUsername: handle }, { senderUsername: null }],
      },
      orderBy: { receivedAt: 'asc' },
    });
    if (waiting.length === 0) return { reprocessed: 0, filed: 0 };

    const senderIds = new Set<string>();
    const unresolved = new Set<string>();
    for (const message of waiting) {
      if (message.senderUsername === handle) senderIds.add(message.senderId);
      else unresolved.add(message.senderId);
    }

    // Messages that arrived before an access token was configured have no
    // username on them. Try once more now — otherwise a scout who links their
    // account after the fact would silently never see those links.
    for (const senderId of unresolved) {
      if (senderIds.has(senderId)) continue;
      const username = await this.graph.lookupUsername(senderId);
      if (username && username === handle) senderIds.add(senderId);
    }

    if (senderIds.size === 0) return { reprocessed: 0, filed: 0 };
    let reprocessed = 0;
    let filed = 0;
    for (const senderId of senderIds) {
      const result = await this.relinkAndReprocess(senderId, scoutId, handle);
      reprocessed += result.reprocessed;
      filed += result.filed;
    }
    return { reprocessed, filed };
  }

  /**
   * Forget everything tied to one Instagram sender.
   *
   * Backs both Meta callbacks: deauthorize (someone removed the app) and data
   * deletion (someone asked for their data to be erased). The scouting rows
   * themselves are the company's own records and stay; what goes is the link to
   * the Instagram person — their messages, their username and the cached id.
   */
  async forgetSender(
    senderId: string,
  ): Promise<{ messagesDeleted: number; scoutsUnlinked: number }> {
    const [messages, scouts] = await this.prisma.$transaction([
      this.prisma.instagramMessage.deleteMany({ where: { senderId } }),
      this.prisma.user.updateMany({
        where: { instagramUserId: senderId },
        data: { instagramUserId: null },
      }),
    ]);
    this.logger.log(
      `Erased Instagram data for sender ${senderId}: ${messages.count} message(s), ${scouts.count} account link(s)`,
    );
    return { messagesDeleted: messages.count, scoutsUnlinked: scouts.count };
  }

  /**
   * A count of links that arrived from accounts nobody has claimed.
   *
   * This exists because of one failure mode: a scout mistypes their handle,
   * their DMs arrive, match nothing, and nobody finds out — they just see
   * "awaiting first DM" forever without knowing why. Surfacing the sending
   * usernames makes the mistake obvious at a glance without putting a whole
   * triage panel back.
   */
  async unmatchedSummary(limit = 8) {
    const rows = await this.prisma.instagramMessage.findMany({
      where: { status: InstagramMessageStatus.UNMATCHED_SENDER },
      select: { senderUsername: true, senderId: true, receivedAt: true },
      orderBy: { receivedAt: 'desc' },
      take: 500,
    });

    const bySender = new Map<string, { label: string; count: number; lastAt: Date }>();
    for (const row of rows) {
      // Fall back to the raw id when the username was never resolved — it's
      // opaque, but "something arrived we couldn't place" still needs saying.
      const key = row.senderUsername ?? `id:${row.senderId}`;
      const existing = bySender.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        bySender.set(key, {
          label: row.senderUsername ? `@${row.senderUsername}` : 'an unidentified account',
          count: 1,
          lastAt: row.receivedAt,
        });
      }
    }

    const senders = Array.from(bySender.values()).sort((a, b) => b.count - a.count);
    return {
      total: rows.length,
      senderCount: senders.length,
      senders: senders.slice(0, Math.max(1, limit)),
    };
  }

  /**
   * Whether the integration is wired up, and whether Meta has ever actually
   * delivered anything.
   *
   * The failure this answers is a specific one: a scout sends links, nothing
   * appears, and there is no way to tell from the outside whether Meta isn't
   * calling, or is calling and being rejected, or is calling and the sender
   * can't be placed. Those need completely different fixes.
   */
  async integrationStatus(configured: {
    appSecret: boolean;
    verifyToken: boolean;
    accessToken: boolean;
  }) {
    const [total, latest, unmatched, deliveries, lastDelivery, account] = await Promise.all([
      this.prisma.instagramMessage.count(),
      this.prisma.instagramMessage.findFirst({
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true, status: true, senderUsername: true },
      }),
      this.prisma.instagramMessage.count({
        where: { status: InstagramMessageStatus.UNMATCHED_SENDER },
      }),
      this.prisma.instagramWebhookDelivery.count(),
      this.prisma.instagramWebhookDelivery.findFirst({ orderBy: { at: 'desc' } }),
      // Answers "does the token belong to the account people are DMing?" here,
      // rather than leaving it to a hand-run curl. It is the check that rules
      // out the most at once, so it should never be the one nobody does.
      configured.accessToken
        ? this.graph.whoami()
        : Promise.resolve({ ok: false as const, error: 'INSTAGRAM_ACCESS_TOKEN is not set' }),
    ]);

    return {
      configured,
      // Which Instagram account the configured token actually controls. If this
      // username isn't the one scouters are messaging, nothing downstream can
      // work: the subscription is on the wrong inbox.
      connectedAccount: account.ok
        ? { username: account.username, id: account.id }
        : { error: account.error },
      // A message has been filed at least once.
      everReceived: total > 0,
      totalMessages: total,
      unmatchedMessages: unmatched,
      // Separately: has Meta ever called at all, accepted or rejected? Durable,
      // so it survives a redeploy — an in-memory answer here was worse than
      // none, because it reset to null every deploy and read as "never called".
      webhookDeliveries: deliveries,
      // Distinguishes "Meta never called" from "Meta called and was turned
      // away", which look identical from the message table alone.
      lastDeliveryAttempt: lastDelivery
        ? {
            at: lastDelivery.at,
            outcome: lastDelivery.outcome,
            detail: lastDelivery.detail,
          }
        : null,
      // Proof the poller is alive, which matters most when the webhook isn't:
      // if this is null well after a deploy, scheduling is off or the token is
      // missing, and nothing is being collected at all.
      lastInboxSync: this.lastInboxSync
        ? { at: this.lastInboxSync.at, detail: this.lastInboxSync.detail }
        : null,
      lastMessageAt: latest?.receivedAt ?? null,
      lastMessageStatus: latest?.status ?? null,
      lastMessageFrom: latest?.senderUsername ?? null,
    };
  }

  /**
   * Work out why no DMs are arriving, and say so in plain English.
   *
   * "Read 0 conversations" has several causes that look identical from the
   * admin page: a token Meta rejects, the app asking Meta the wrong way, the
   * account not subscribed to message webhooks, or Meta simply withholding the
   * DMs from this app. Each gets asked about directly here, so the answer comes
   * from Meta's own replies instead of another round of guessing.
   *
   * Only reports usernames, counts and Meta's error text — never the token.
   */
  async diagnose(): Promise<InstagramDiagnosis> {
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

    // 1. Whose token is this, and is it a professional account?
    const me = await this.graph.probe(
      '/me',
      { fields: 'id,user_id,username,account_type' },
      DIAGNOSE_GRAPH_VERSION,
    );
    const account = me.ok
      ? {
          ok: true as const,
          username: str(me.body.username),
          accountType: str(me.body.account_type),
          // Only trusted as a string: a 17-digit id through a JSON number is
          // already rounded.
          userId: str(me.body.user_id),
        }
      : { ok: false as const, error: me.error };

    // 2. The inbox, asked three ways. The first is exactly how the poller asks.
    const convoParams = { platform: 'instagram', fields: 'participants,updated_time' };
    const variants: Array<{ label: string; path: string; version?: string }> = [
      { label: 'the way the app reads it now', path: '/me/conversations' },
      {
        label: `pinned to API ${DIAGNOSE_GRAPH_VERSION}`,
        path: '/me/conversations',
        version: DIAGNOSE_GRAPH_VERSION,
      },
    ];
    if (account.ok && account.userId) {
      variants.push({
        label: `by account id, API ${DIAGNOSE_GRAPH_VERSION}`,
        path: `/${account.userId}/conversations`,
        version: DIAGNOSE_GRAPH_VERSION,
      });
    }
    const own = account.ok ? account.username : null;
    const inbox: InboxProbe[] = [];
    for (const v of variants) {
      const res = await this.graph.probe(v.path, convoParams, v.version);
      if (!res.ok) {
        inbox.push({
          label: v.label,
          ok: false,
          conversations: 0,
          participants: [],
          error: res.error,
        });
        continue;
      }
      const data = Array.isArray(res.body.data)
        ? (res.body.data as Array<Record<string, unknown>>)
        : [];
      const participants = new Set<string>();
      for (const convo of data) {
        const people = (convo.participants as { data?: unknown } | undefined)?.data;
        for (const p of Array.isArray(people) ? people : []) {
          const name = str((p as Record<string, unknown>)?.username);
          if (name && name !== own) participants.add(`@${name}`);
        }
      }
      inbox.push({
        label: v.label,
        ok: true,
        conversations: data.length,
        participants: Array.from(participants).slice(0, 10),
      });
    }

    // 3. Is the account subscribed to message webhooks, as Meta sees it?
    const subs = await this.graph.probe('/me/subscribed_apps', {}, DIAGNOSE_GRAPH_VERSION);
    let webhookSubscription: InstagramDiagnosis['webhookSubscription'];
    if (subs.ok) {
      const fields = new Set<string>();
      for (const app of Array.isArray(subs.body.data) ? subs.body.data : []) {
        const raw = (app as Record<string, unknown>)?.subscribed_fields;
        for (const f of Array.isArray(raw) ? raw : []) {
          const name = typeof f === 'string' ? f : str((f as Record<string, unknown>)?.name);
          if (name) fields.add(name);
        }
      }
      webhookSubscription = { ok: true, fields: Array.from(fields) };
    } else {
      webhookSubscription = { ok: false, error: subs.error };
    }

    // 4. Has Meta ever called us?
    const [deliveries, lastDelivery, storedMessages] = await Promise.all([
      this.prisma.instagramWebhookDelivery.count(),
      this.prisma.instagramWebhookDelivery.findFirst({ orderBy: { at: 'desc' } }),
      this.prisma.instagramMessage.count(),
    ]);
    const webhook = {
      deliveries,
      storedMessages,
      lastDelivery: lastDelivery
        ? { at: lastDelivery.at, outcome: lastDelivery.outcome, detail: lastDelivery.detail }
        : null,
    };

    return {
      account,
      inbox,
      webhookSubscription,
      webhook,
      verdict: diagnosisVerdict(account, inbox, webhookSubscription, webhook),
    };
  }

  /**
   * Read the connected account's inbox directly and file anything new.
   *
   * The webhook is the intended path, but it depends on Meta actually calling —
   * which can fail silently for reasons invisible from here (an unaccepted
   * message request, a disabled messaging toggle, app-mode restrictions). This
   * asks for the messages instead, so the feature works either way. It also
   * picks up messages sent BEFORE the integration was wired up, which a webhook
   * can never backfill.
   *
   * Safe to run alongside the webhook: ingestion is keyed on Meta's message id,
   * so a message seen by both routes is filed once.
   *
   * Returns a diagnostic summary rather than throwing, because the first
   * question when nothing appears is "what did Meta actually return?".
   */
  async syncInbox(): Promise<{
    ok: boolean;
    error?: string;
    conversations: number;
    messagesSeen: number;
    ownMessagesSkipped: number;
    filed: number;
    alreadyKnown: number;
    unmatched: number;
    sample?: unknown;
  }> {
    // The account's own id only changes with the token, and a new token means a
    // redeploy, so look it up once rather than on every poll — at one poll every
    // 35 seconds that halves the calls counted against Meta's rate limit.
    if (!this.businessAccount) this.businessAccount = await this.graph.me();
    const me = this.businessAccount;
    const res = await this.graph.fetchConversations();

    if (!res.ok) {
      this.logger.warn(`Instagram inbox sync failed: ${res.error}`);
      return {
        ok: false,
        error: res.error,
        conversations: 0,
        messagesSeen: 0,
        ownMessagesSkipped: 0,
        filed: 0,
        alreadyKnown: 0,
        unmatched: 0,
      };
    }

    const conversations = Array.isArray(res.body.data) ? res.body.data : [];
    let messagesSeen = 0;
    let ownMessagesSkipped = 0;
    let filed = 0;
    let alreadyKnown = 0;
    let unmatched = 0;
    let sample: unknown;

    for (const raw of conversations as Array<Record<string, unknown>>) {
      const wrapper = (raw?.messages ?? {}) as { data?: unknown };
      const messages = Array.isArray(wrapper.data) ? wrapper.data : [];

      for (const item of messages as Array<Record<string, unknown>>) {
        const id = typeof item.id === 'string' ? item.id : null;
        const from = (item.from ?? {}) as { id?: unknown; username?: unknown };
        const senderId = typeof from.id === 'string' ? from.id : null;
        if (!id || !senderId) continue;

        messagesSeen += 1;
        // Keep one example so a shape we don't understand can be inspected
        // rather than guessed at.
        if (!sample) sample = item;

        // Messages the company account sent are not scouting finds.
        if (me && senderId === me.id) {
          ownMessagesSkipped += 1;
          continue;
        }

        const outcome = await this.ingest({
          messageId: id,
          senderId,
          text: typeof item.message === 'string' ? item.message : null,
          attachmentUrls: attachmentUrls(item),
          shares: sharedItems(item),
          raw: item,
        });

        if (outcome.note === 'duplicate delivery') alreadyKnown += 1;
        else if (outcome.status === InstagramMessageStatus.APPLIED) filed += 1;
        else if (outcome.status === InstagramMessageStatus.UNMATCHED_SENDER) unmatched += 1;
      }
    }

    // Deliberately not recorded as a webhook delivery: that table answers
    // "has Meta ever called us?", and polling every couple of minutes would
    // both bury the answer and swamp the table. Kept in memory instead — a
    // poll that resets on deploy costs nothing, since the next one is minutes
    // away.
    this.lastInboxSync = {
      at: new Date(),
      detail: `${conversations.length} conversation(s), ${messagesSeen} message(s), ${filed} filed`,
    };
    this.logger.log(
      `Instagram inbox sync: ${conversations.length} conversation(s), ${messagesSeen} message(s), ${filed} filed, ${alreadyKnown} already known, ${unmatched} unmatched`,
    );

    return {
      ok: true,
      conversations: conversations.length,
      messagesSeen,
      ownMessagesSkipped,
      filed,
      alreadyKnown,
      unmatched,
      // Only when messages were read but none could be accounted for. Messages
      // already on file are a normal repeat run, not a payload we failed to
      // understand, and dumping a sample there is just noise.
      ...(filed === 0 && alreadyKnown === 0 && unmatched === 0 && messagesSeen > 0
        ? { sample }
        : {}),
    };
  }

  /** Recent inbound messages for the admin log. */
  async recent(limit = 50, status?: InstagramMessageStatus) {
    return this.prisma.instagramMessage.findMany({
      where: status ? { status } : undefined,
      orderBy: { receivedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      include: {
        scout: { select: { id: true, username: true, displayName: true } },
        entry: { select: { id: true, rowNumber: true } },
      },
    });
  }
}
