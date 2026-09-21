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
   * Bind an unplaced sender to a scout and re-file everything they've already
   * sent.
   *
   * This is the recovery path when a sender can't be resolved automatically —
   * no access token configured, or the scout's Instagram username differs from
   * the handle on file. An admin points one unmatched message at the right
   * scout; the sender's Instagram id is cached on that scout, and every message
   * already sitting unmatched from that same id is processed as if it had
   * arrived now, so nothing has to be re-sent.
   */
  async assignSender(messageId: string, scoutId: string) {
    const message = await this.prisma.instagramMessage.findUnique({ where: { id: messageId } });
    if (!message) throw new Error('Message not found');

    const scout = await this.prisma.user.findUnique({ where: { id: scoutId } });
    if (!scout) throw new Error('Scout not found');

    // An Instagram id belongs to exactly one scout; release it from whoever
    // held it before rather than failing on the unique constraint.
    await this.prisma.user.updateMany({
      where: { instagramUserId: message.senderId, NOT: { id: scoutId } },
      data: { instagramUserId: null },
    });
    await this.prisma.user.update({
      where: { id: scoutId },
      data: {
        instagramUserId: message.senderId,
        // Adopt the sender's username as the handle when none was on file.
        ...(scout.instagramHandle || !message.senderUsername
          ? {}
          : { instagramHandle: message.senderUsername }),
      },
    });

    const pending = await this.prisma.instagramMessage.findMany({
      where: { senderId: message.senderId, status: InstagramMessageStatus.UNMATCHED_SENDER },
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
      `Linked Instagram sender ${message.senderId} to scout ${scout.username}; re-filed ${filed} message(s)`,
    );
    return { linked: true as const, scoutId, reprocessed: pending.length, filed };
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
