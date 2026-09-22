import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InstagramMessageStatus, Prisma, ScoutEntry, User } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { normalizeInstagram } from '../../common/utils/normalize';
import { attachmentUrls, classifyMessageLinks } from './instagram-links';
import { InstagramGraphService } from './instagram-graph.service';

/** One message lifted out of a webhook payload. */
export interface InboundMessage {
  messageId: string;
  senderId: string;
  text?: string | null;
  attachmentUrls: string[];
  raw: unknown;
}

export interface IngestOutcome {
  status: InstagramMessageStatus;
  note?: string;
  entryId?: string | null;
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

  /**
   * The most recent webhook attempt and how it went, including ones that were
   * rejected before anything could be stored.
   *
   * Rejected deliveries leave no database row, so without this the only record
   * of them is a log line — and "check the logs" is a poor answer when the
   * question is simply "did Meta call us at all?". Held in memory: it is a live
   * diagnostic, not history, and resets on deploy.
   */
  private lastDelivery: { at: Date; outcome: string; detail?: string } | null = null;

  /** Record how a webhook delivery ended, whatever the outcome. */
  recordDelivery(outcome: string, detail?: string): void {
    this.lastDelivery = { at: new Date(), outcome, detail };
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

    const links = classifyMessageLinks({ text: msg.text, attachmentUrls: msg.attachmentUrls });
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
      await this.prisma.instagramMessage.create({
        data: {
          ...record,
          senderUsername: username ?? scout.instagramHandle,
          scoutId: scout.id,
          status: InstagramMessageStatus.NO_LINKS,
          statusNote: links.otherLinks.length
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
      const event = (row.raw ?? {}) as Record<string, unknown>;
      const inner = (event.message ?? {}) as Record<string, unknown>;
      // Clear the old ledger row so ingest doesn't treat this as a duplicate.
      await this.prisma.instagramMessage.delete({ where: { id: row.id } });
      const outcome = await this.ingest({
        messageId: row.messageId,
        senderId: row.senderId,
        text: row.text,
        attachmentUrls: attachmentUrls(inner),
        raw: row.raw,
      });
      if (outcome.status === InstagramMessageStatus.APPLIED) filed += 1;
    }

    this.logger.log(
      `Linked Instagram sender ${senderId} to scout ${scout.username}; re-filed ${filed} message(s)`,
    );
    return { linked: true as const, scoutId, reprocessed: pending.length, filed };
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
    const [total, latest, unmatched] = await Promise.all([
      this.prisma.instagramMessage.count(),
      this.prisma.instagramMessage.findFirst({
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true, status: true, senderUsername: true },
      }),
      this.prisma.instagramMessage.count({
        where: { status: InstagramMessageStatus.UNMATCHED_SENDER },
      }),
    ]);

    return {
      configured,
      // A delivery has reached us at least once. If this is null and the
      // settings above are all true, Meta simply isn't sending — the problem is
      // in the Meta app's webhook subscription, not here.
      everReceived: total > 0,
      totalMessages: total,
      unmatchedMessages: unmatched,
      // Distinguishes "Meta never called" from "Meta called and was turned
      // away", which look identical from the message table alone.
      lastDeliveryAttempt: this.lastDelivery
        ? {
            at: this.lastDelivery.at,
            outcome: this.lastDelivery.outcome,
            detail: this.lastDelivery.detail ?? null,
          }
        : null,
      lastMessageAt: latest?.receivedAt ?? null,
      lastMessageStatus: latest?.status ?? null,
      lastMessageFrom: latest?.senderUsername ?? null,
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
    const me = await this.graph.me();
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
          raw: item,
        });

        if (outcome.note === 'duplicate delivery') alreadyKnown += 1;
        else if (outcome.status === InstagramMessageStatus.APPLIED) filed += 1;
        else if (outcome.status === InstagramMessageStatus.UNMATCHED_SENDER) unmatched += 1;
      }
    }

    this.recordDelivery(
      'inbox_sync',
      `Read ${conversations.length} conversation(s), ${messagesSeen} message(s); filed ${filed}`,
    );
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
