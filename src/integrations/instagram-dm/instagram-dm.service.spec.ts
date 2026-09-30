import { ConfigService } from '@nestjs/config';
import { InstagramMessageStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { InstagramDmService } from './instagram-dm.service';
import { InstagramGraphService } from './instagram-graph.service';

const SCOUT = { id: 'scout-1', instagramHandle: 'scouty', isActive: true };

function makeDeps(over: { entryFindFirst?: jest.Mock; user?: unknown } = {}) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const messages: unknown[] = [];

  const prisma = {
    instagramMessage: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn((args: never) => {
        messages.push((args as { data: unknown }).data);
        return Promise.resolve({ id: 'm1' });
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(over.user === undefined ? SCOUT : over.user),
      update: jest.fn((a: never) => Promise.resolve({ ...SCOUT, ...(a as { data: object }).data })),
    },
    scoutEntry: {
      findFirst: over.entryFindFirst ?? jest.fn().mockResolvedValue(null),
      create: jest.fn((a: never) => {
        const data = (a as { data: Record<string, unknown> }).data;
        created.push(data);
        return Promise.resolve({ id: 'e-new', rowNumber: data.rowNumber, ...data });
      }),
      update: jest.fn((a: never) => {
        const args = a as { where: { id: string }; data: Record<string, unknown> };
        updated.push({ id: args.where.id, ...args.data });
        return Promise.resolve({ id: args.where.id, rowNumber: 7, ...args.data });
      }),
    },
  } as unknown as PrismaService;

  const config = {
    get: jest.fn((k: string) => (k === 'instagramDm.pairWindowHours' ? 24 : undefined)),
  } as unknown as ConfigService;
  const graph = {
    lookupUsername: jest.fn().mockResolvedValue('scouty'),
  } as unknown as InstagramGraphService;

  return { prisma, config, graph, created, updated, messages };
}

const msg = (over: Partial<{ messageId: string; senderId: string; text: string | null }> = {}) => ({
  messageId: over.messageId ?? 'mid-1',
  senderId: over.senderId ?? 'IGSID_1',
  text: over.text === undefined ? null : over.text,
  attachmentUrls: [] as string[],
  raw: {},
});

describe('InstagramDmService.extractMessages', () => {
  const svc = () => {
    const d = makeDeps();
    return new InstagramDmService(d.prisma, d.config, d.graph);
  };

  it('pulls sender, id, text and attachment urls out of a webhook', () => {
    const out = svc().extractMessages({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'IGSID_1' },
              message: {
                mid: 'mid-1',
                text: 'look at this',
                attachments: [
                  { type: 'ig_reel', payload: { url: 'https://instagram.com/reel/A/' } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      messageId: 'mid-1',
      senderId: 'IGSID_1',
      text: 'look at this',
      attachmentUrls: ['https://instagram.com/reel/A/'],
    });
  });

  it('ignores our own echoed messages and deleted ones', () => {
    const out = svc().extractMessages({
      entry: [
        {
          messaging: [
            { sender: { id: 'x' }, message: { mid: 'a', is_echo: true, text: 'hi' } },
            { sender: { id: 'x' }, message: { mid: 'b', is_deleted: true } },
            { sender: { id: 'x' }, message: { text: 'no mid' } },
          ],
        },
      ],
    });
    expect(out).toEqual([]);
  });

  it('survives an empty or unfamiliar payload', () => {
    expect(svc().extractMessages({})).toEqual([]);
    expect(svc().extractMessages(null)).toEqual([]);
  });

  it('reads a reel sent with the Share button, whose url is only a CDN link', () => {
    const out = svc().extractMessages(shareWebhook());
    expect(out[0].shares).toEqual([
      expect.objectContaining({ kind: 'reel', source: 'ig_reel', url: CDN, mediaId: '179123' }),
    ]);
  });
});

// A shared reel exactly as Meta delivers it: no text, and a lookaside media URL
// rather than an instagram.com permalink.
const CDN = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=179123&signature=AbC';
const shareEvent = () => ({
  sender: { id: 'IGSID_1' },
  message: {
    mid: 'mid-share',
    attachments: [
      { type: 'ig_reel', payload: { reel_video_id: '179123', title: 'hack', url: CDN } },
    ],
  },
});
const shareWebhook = () => ({ object: 'instagram', entry: [{ messaging: [shareEvent()] }] });

describe('InstagramDmService — Share-button shares', () => {
  it('files a shared reel onto the scout sheet instead of dropping it as "no links"', async () => {
    const d = makeDeps();
    const svc = new InstagramDmService(d.prisma, d.config, d.graph);
    const [message] = svc.extractMessages(shareWebhook());

    const out = await svc.ingest(message);

    expect(out.status).toBe(InstagramMessageStatus.APPLIED);
    expect(d.created[0]).toMatchObject({ instagramProfileLink: '', reelIdeas: CDN });
    expect(d.messages[0]).toMatchObject({ reelLinks: [CDN], otherLinks: [] });
  });

  it('puts the permanent instagram.com link on the sheet when the media id allows it', async () => {
    const d = makeDeps();
    const svc = new InstagramDmService(d.prisma, d.config, d.graph);
    const event = shareEvent();
    event.message.attachments[0].payload.reel_video_id = '2243569220713804232';
    const [message] = svc.extractMessages({ entry: [{ messaging: [event] }] });

    await svc.ingest(message);

    expect(d.created[0]).toMatchObject({
      reelIdeas: 'https://www.instagram.com/reel/B8iwlG9pXHI',
    });
  });

  it('says a share came through unsupported, rather than calling it chatter', async () => {
    const d = makeDeps();
    await new InstagramDmService(d.prisma, d.config, d.graph).ingest({
      ...msg(),
      shares: [],
      raw: { sender: { id: 'IGSID_1' }, message: { mid: 'mid-1', is_unsupported: true } },
    });
    expect(d.messages[0]).toMatchObject({ status: InstagramMessageStatus.NO_LINKS });
    expect((d.messages[0] as { statusNote: string }).statusNote).toMatch(/unsupported/);
  });
});

describe('InstagramDmService.refileDroppedShares', () => {
  function withStored(rows: unknown[]) {
    const d = makeDeps();
    const im = d.prisma.instagramMessage as unknown as Record<string, jest.Mock>;
    im.findMany = jest.fn().mockResolvedValue(rows);
    im.delete = jest.fn().mockResolvedValue({});
    return { d, im, svc: new InstagramDmService(d.prisma, d.config, d.graph) };
  }

  const stored = (id: string, raw: unknown, text: string | null = null) => ({
    id,
    messageId: `mid-${id}`,
    senderId: 'IGSID_1',
    text,
    raw,
    status: InstagramMessageStatus.NO_LINKS,
  });

  it('re-files a share that was recorded as "no links" from its stored payload', async () => {
    const { d, im, svc } = withStored([stored('r1', shareEvent())]);

    const out = await svc.refileDroppedShares();

    expect(out).toEqual({ checked: 1, refiled: 1 });
    expect(im.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(d.created[0]).toMatchObject({ reelIdeas: CDN });
  });

  it('also re-files shares that were read from the inbox, not a webhook', async () => {
    const polled = {
      id: 'mid-p',
      from: { id: 'IGSID_1' },
      attachments: { data: [{ video_data: { url: CDN } }] },
    };
    const { d, svc } = withStored([stored('p1', polled)]);
    expect((await svc.refileDroppedShares()).refiled).toBe(1);
    expect(d.created[0]).toMatchObject({ reelIdeas: CDN });
  });

  it('leaves a message that genuinely had nothing in it alone', async () => {
    const { d, im, svc } = withStored([
      stored('c1', { sender: { id: 'IGSID_1' }, message: { mid: 'x', text: 'hi' } }, 'hi'),
    ]);
    expect(await svc.refileDroppedShares()).toEqual({ checked: 1, refiled: 0 });
    expect(im.delete).not.toHaveBeenCalled();
    expect(d.created).toHaveLength(0);
  });

  it('only looks at messages that were dropped as "no links", oldest first', async () => {
    const { im, svc } = withStored([]);
    await svc.refileDroppedShares();
    expect(im.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: InstagramMessageStatus.NO_LINKS },
        orderBy: { receivedAt: 'asc' },
      }),
    );
  });
});

describe('InstagramDmService.upgradeReelLinks', () => {
  const PK = '2243569220713804232';
  const PERMALINK = 'https://www.instagram.com/reel/B8iwlG9pXHI';
  const cdn = `https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=${PK}&signature=s`;
  const filed = (reelLinks: string[], payload: Record<string, unknown> = { url: cdn }) => ({
    id: 'msg-1',
    entryId: 'row-1',
    reelLinks,
    raw: { sender: { id: 'IGSID_1' }, message: { attachments: [{ type: 'ig_reel', payload }] } },
  });

  function withFiled(rows: unknown[], cell: string | null) {
    const d = makeDeps();
    const im = d.prisma.instagramMessage as unknown as Record<string, jest.Mock>;
    const se = d.prisma.scoutEntry as unknown as Record<string, jest.Mock>;
    im.findMany = jest.fn().mockResolvedValue(rows);
    im.update = jest.fn().mockResolvedValue({});
    se.findUnique = jest.fn().mockResolvedValue({ reelIdeas: cell });
    return { im, se, svc: new InstagramDmService(d.prisma, d.config, d.graph) };
  }

  it('replaces an expiring media link on the sheet with the permanent one', async () => {
    const { im, se, svc } = withFiled([filed([cdn])], cdn);

    expect(await svc.upgradeReelLinks()).toEqual({ checked: 1, upgraded: 1 });
    expect(se.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { reelIdeas: PERMALINK },
    });
    // The message log follows, so the row isn't revisited on the next run.
    expect(im.update).toHaveBeenCalledWith({
      where: { id: 'msg-1' },
      data: { reelLinks: [PERMALINK] },
    });
  });

  it('leaves a sheet cell a scout has since edited alone', async () => {
    const { se, svc } = withFiled([filed([cdn])], 'https://www.instagram.com/reel/theirOwnPick');
    expect((await svc.upgradeReelLinks()).upgraded).toBe(0);
    expect(se.update).not.toHaveBeenCalled();
  });

  it('keeps the media link when the id cannot be converted', async () => {
    const graphOnly =
      'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=17912345678901234&signature=s';
    const { im, se, svc } = withFiled([filed([graphOnly], { url: graphOnly })], graphOnly);
    expect(await svc.upgradeReelLinks()).toEqual({ checked: 1, upgraded: 0 });
    expect(se.update).not.toHaveBeenCalled();
    expect(im.update).not.toHaveBeenCalled();
  });

  it('skips rows that already hold instagram.com links without reading the sheet', async () => {
    const { se, svc } = withFiled([filed([PERMALINK])], PERMALINK);
    expect(await svc.upgradeReelLinks()).toEqual({ checked: 0, upgraded: 0 });
    expect(se.findUnique).not.toHaveBeenCalled();
  });

  it('only looks at filed messages', async () => {
    const { im, svc } = withFiled([], null);
    await svc.upgradeReelLinks();
    expect(im.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: InstagramMessageStatus.APPLIED, entryId: { not: null } },
      }),
    );
  });
});

describe('InstagramDmService.ingest', () => {
  it('skips a message it has already filed', async () => {
    const d = makeDeps();
    (d.prisma.instagramMessage.findUnique as jest.Mock).mockResolvedValue({
      id: 'm1',
      status: InstagramMessageStatus.APPLIED,
      entryId: 'e1',
    });
    const out = await new InstagramDmService(d.prisma, d.config, d.graph).ingest(msg());
    expect(out.note).toMatch(/duplicate/);
    expect(d.prisma.scoutEntry.create).not.toHaveBeenCalled();
    expect(d.prisma.scoutEntry.update).not.toHaveBeenCalled();
  });

  it('files a message from an unknown sender without touching any sheet', async () => {
    const d = makeDeps({ user: null });
    const out = await new InstagramDmService(d.prisma, d.config, d.graph).ingest(
      msg({ text: 'https://instagram.com/someone' }),
    );
    expect(out.status).toBe(InstagramMessageStatus.UNMATCHED_SENDER);
    expect(d.prisma.scoutEntry.create).not.toHaveBeenCalled();
  });

  it('records a chatty message with no links and creates no row', async () => {
    const d = makeDeps();
    const out = await new InstagramDmService(d.prisma, d.config, d.graph).ingest(
      msg({ text: 'sending some over now' }),
    );
    expect(out.status).toBe(InstagramMessageStatus.NO_LINKS);
    expect(d.prisma.scoutEntry.create).not.toHaveBeenCalled();
  });

  it('starts a new row when a profile arrives and nothing is waiting', async () => {
    const d = makeDeps();
    await new InstagramDmService(d.prisma, d.config, d.graph).ingest(
      msg({ text: 'https://instagram.com/mazeirons' }),
    );
    expect(d.created).toHaveLength(1);
    expect(d.created[0]).toMatchObject({
      instagramProfileLink: 'https://instagram.com/mazeirons',
      instagramUsername: 'mazeirons',
      reelIdeas: null,
    });
  });

  it('fills the waiting reel-only row when the profile follows', async () => {
    // A row created earlier by a reel: profile blank, reel present.
    const waiting = {
      id: 'e-reel-only',
      instagramProfileLink: '',
      reelIdeas: 'https://instagram.com/reel/A',
    };
    const d = makeDeps({ entryFindFirst: jest.fn().mockResolvedValue(waiting) });
    await new InstagramDmService(d.prisma, d.config, d.graph).ingest(
      msg({ text: 'https://instagram.com/mazeirons' }),
    );
    expect(d.created).toHaveLength(0);
    expect(d.updated[0]).toMatchObject({
      id: 'e-reel-only',
      instagramProfileLink: 'https://instagram.com/mazeirons',
      instagramUsername: 'mazeirons',
    });
  });

  it('fills the waiting profile-only row when the reel follows', async () => {
    const waiting = {
      id: 'e-profile-only',
      instagramProfileLink: 'https://instagram.com/x',
      reelIdeas: null,
    };
    const d = makeDeps({ entryFindFirst: jest.fn().mockResolvedValue(waiting) });
    await new InstagramDmService(d.prisma, d.config, d.graph).ingest(
      msg({ text: 'https://instagram.com/reel/Da3JEdVow8N/' }),
    );
    expect(d.created).toHaveLength(0);
    expect(d.updated[0]).toMatchObject({
      id: 'e-profile-only',
      reelIdeas: 'https://instagram.com/reel/Da3JEdVow8N',
    });
  });

  it('starts a row with a blank profile when a reel arrives first', async () => {
    const d = makeDeps();
    await new InstagramDmService(d.prisma, d.config, d.graph).ingest(
      msg({ text: 'https://instagram.com/reel/Da3JEdVow8N/' }),
    );
    expect(d.created[0]).toMatchObject({
      instagramProfileLink: '',
      reelIdeas: 'https://instagram.com/reel/Da3JEdVow8N',
    });
  });

  it('puts a profile and reel sent together on one row', async () => {
    const d = makeDeps();
    // Nothing waiting for the profile; the row it creates is then found by the
    // reel's lookup, which is what keeps the pair together.
    (d.prisma.scoutEntry.findFirst as jest.Mock)
      .mockResolvedValueOnce(null) // no reel-only row waiting
      .mockResolvedValueOnce({ rowNumber: 3 }) // rowNumber allocation
      .mockResolvedValueOnce({
        id: 'e-new',
        instagramProfileLink: 'https://instagram.com/mazeirons',
        reelIdeas: null,
      });

    await new InstagramDmService(d.prisma, d.config, d.graph).ingest(
      msg({ text: 'https://instagram.com/mazeirons and https://instagram.com/reel/AAA/' }),
    );

    expect(d.created).toHaveLength(1);
    expect(d.updated).toHaveLength(1);
    expect(d.updated[0]).toMatchObject({ reelIdeas: 'https://instagram.com/reel/AAA' });
  });

  it('caches the sender id on the scout so later messages skip the lookup', async () => {
    const d = makeDeps();
    (d.prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce(null) // no cached IGSID
      .mockResolvedValueOnce(SCOUT); // matched by handle
    await new InstagramDmService(d.prisma, d.config, d.graph).ingest(
      msg({ text: 'https://instagram.com/mazeirons' }),
    );
    expect(d.prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { instagramUserId: 'IGSID_1' } }),
    );
  });
});

describe('InstagramDmService.claimForScout', () => {
  const SCOUT_WITH_HANDLE = { id: 'scout-1', username: 'priya', instagramHandle: 'priya.scouts' };

  function claimDeps(messages: Array<Record<string, unknown>>, lookup?: string | null) {
    const deleted: string[] = [];
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(SCOUT_WITH_HANDLE),
        findFirst: jest.fn().mockResolvedValue(SCOUT_WITH_HANDLE),
        update: jest.fn().mockResolvedValue(SCOUT_WITH_HANDLE),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      instagramMessage: {
        findMany: jest.fn().mockResolvedValue(messages),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'm' }),
        delete: jest.fn((a: never) => {
          deleted.push((a as { where: { id: string } }).where.id);
          return Promise.resolve({});
        }),
      },
      scoutEntry: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'e1', rowNumber: 1 }),
        update: jest.fn().mockResolvedValue({ id: 'e1', rowNumber: 1 }),
      },
    } as unknown as PrismaService;

    const config = { get: jest.fn().mockReturnValue(24) } as unknown as ConfigService;
    const graph = {
      lookupUsername: jest.fn().mockResolvedValue(lookup === undefined ? null : lookup),
    } as unknown as InstagramGraphService;
    return { prisma, config, graph, deleted };
  }

  const waiting = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    messageId: 'mid-1',
    senderId: 'IGSID_SELF',
    senderUsername: 'priya.scouts',
    text: 'https://instagram.com/found',
    raw: { message: { mid: 'mid-1', text: 'https://instagram.com/found' } },
    ...over,
  });

  it("claims messages already tagged with the scout's handle", async () => {
    const d = claimDeps([waiting()]);
    const out = await new InstagramDmService(d.prisma, d.config, d.graph).claimForScout('scout-1');
    expect(out.reprocessed).toBe(1);
    expect(d.prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ instagramUserId: 'IGSID_SELF' }) }),
    );
  });

  it('re-resolves senders that arrived before a token was configured', async () => {
    // senderUsername is null because there was no access token at the time.
    const d = claimDeps([waiting({ senderUsername: null })], 'priya.scouts');
    const out = await new InstagramDmService(d.prisma, d.config, d.graph).claimForScout('scout-1');
    expect(d.graph.lookupUsername).toHaveBeenCalledWith('IGSID_SELF');
    expect(out.reprocessed).toBe(1);
  });

  it("leaves a stranger's message alone when the lookup says someone else", async () => {
    const d = claimDeps(
      [waiting({ senderUsername: null, senderId: 'IGSID_OTHER' })],
      'someone.else',
    );
    const out = await new InstagramDmService(d.prisma, d.config, d.graph).claimForScout('scout-1');
    expect(out).toEqual({ reprocessed: 0, filed: 0 });
    expect(d.prisma.user.update).not.toHaveBeenCalled();
  });

  it('does nothing for a scout who has not set a handle', async () => {
    const d = claimDeps([waiting()]);
    (d.prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'scout-1',
      instagramHandle: null,
    });
    await expect(
      new InstagramDmService(d.prisma, d.config, d.graph).claimForScout('scout-1'),
    ).resolves.toEqual({ reprocessed: 0, filed: 0 });
  });
});

describe('InstagramDmService.unmatchedSummary', () => {
  function summaryDeps(rows: Array<Record<string, unknown>>) {
    const prisma = {
      instagramMessage: { findMany: jest.fn().mockResolvedValue(rows) },
    } as unknown as PrismaService;
    const config = { get: jest.fn().mockReturnValue(24) } as unknown as ConfigService;
    const graph = { lookupUsername: jest.fn() } as unknown as InstagramGraphService;
    return new InstagramDmService(prisma, config, graph);
  }

  const at = (d: string) => new Date(d);

  it('says nothing when everything has been filed', async () => {
    await expect(summaryDeps([]).unmatchedSummary()).resolves.toEqual({
      total: 0,
      senderCount: 0,
      senders: [],
    });
  });

  it('groups by sender and counts their links, busiest first', async () => {
    const out = await summaryDeps([
      { senderUsername: 'priya.scouts', senderId: 'A', receivedAt: at('2026-01-02') },
      { senderUsername: 'priya.scouts', senderId: 'A', receivedAt: at('2026-01-01') },
      { senderUsername: 'someone.else', senderId: 'B', receivedAt: at('2026-01-03') },
    ]).unmatchedSummary();

    expect(out.total).toBe(3);
    expect(out.senderCount).toBe(2);
    expect(out.senders[0]).toMatchObject({ label: '@priya.scouts', count: 2 });
    expect(out.senders[1]).toMatchObject({ label: '@someone.else', count: 1 });
  });

  it('still reports a sender whose username was never resolved', async () => {
    const out = await summaryDeps([
      { senderUsername: null, senderId: 'IGSID_X', receivedAt: at('2026-01-01') },
    ]).unmatchedSummary();
    // Opaque, but "something arrived we could not place" still needs saying.
    expect(out.senders[0].label).toBe('an unidentified account');
    expect(out.total).toBe(1);
  });

  it('caps how many senders it names', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      senderUsername: `scout${i}`,
      senderId: `S${i}`,
      receivedAt: at('2026-01-01'),
    }));
    const out = await summaryDeps(rows).unmatchedSummary(3);
    expect(out.total).toBe(12);
    expect(out.senderCount).toBe(12);
    expect(out.senders).toHaveLength(3);
  });
});

describe('InstagramDmService.integrationStatus', () => {
  /**
   * Deliveries are stored, so the fake stores them too — an assertion against a
   * fake that merely remembers the last call in memory would have passed for
   * the very bug this replaced.
   */
  function statusDeps(
    total: number,
    unmatched: number,
    latest: unknown,
    who: { ok: true; id: string; username: string } | { ok: false; error: string } = {
      ok: true,
      id: 'BIZ',
      username: 'influence__inc',
    },
  ) {
    const deliveries: { outcome: string; detail: string | null; at: Date }[] = [];
    const prisma = {
      instagramMessage: {
        count: jest.fn().mockResolvedValueOnce(total).mockResolvedValueOnce(unmatched),
        findFirst: jest.fn().mockResolvedValue(latest),
      },
      instagramWebhookDelivery: {
        create: jest.fn(({ data }: { data: { outcome: string; detail: string | null } }) => {
          deliveries.push({ ...data, at: new Date() });
          return Promise.resolve(data);
        }),
        count: jest.fn(() => Promise.resolve(deliveries.length)),
        findFirst: jest.fn(() => Promise.resolve(deliveries[deliveries.length - 1] ?? null)),
      },
    } as unknown as PrismaService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    const graph = {
      lookupUsername: jest.fn(),
      whoami: jest.fn().mockResolvedValue(who),
    } as unknown as InstagramGraphService;
    return new InstagramDmService(prisma, config, graph);
  }

  const allSet = { appSecret: true, verifyToken: true, accessToken: true };

  it('reports that Meta has never delivered anything', async () => {
    const out = await statusDeps(0, 0, null).integrationStatus(allSet);
    expect(out.everReceived).toBe(false);
    expect(out.totalMessages).toBe(0);
    expect(out.lastMessageAt).toBeNull();
    // Nothing filed AND nothing ever called: the problem is Meta's
    // subscription, not this service.
    expect(out.webhookDeliveries).toBe(0);
  });

  it('names the Instagram account the configured token actually controls', async () => {
    const out = await statusDeps(0, 0, null).integrationStatus(allSet);
    // The check that rules out the most at once, answered without a hand-run
    // curl: a token for the wrong account subscribes the wrong inbox.
    expect(out.connectedAccount).toEqual({ username: 'influence__inc', id: 'BIZ' });
  });

  it('surfaces why the account could not be read instead of going quiet', async () => {
    const out = await statusDeps(0, 0, null, {
      ok: false,
      error: 'Invalid OAuth access token',
    }).integrationStatus(allSet);
    expect(out.connectedAccount).toEqual({ error: 'Invalid OAuth access token' });
  });

  it('does not call Graph when there is no token to call it with', async () => {
    const out = await statusDeps(0, 0, null).integrationStatus({
      appSecret: true,
      verifyToken: true,
      accessToken: false,
    });
    expect(out.connectedAccount).toEqual({ error: 'INSTAGRAM_ACCESS_TOKEN is not set' });
  });

  it('reports the most recent delivery once something has arrived', async () => {
    const at = new Date('2026-09-22T10:00:00Z');
    const out = await statusDeps(5, 2, {
      receivedAt: at,
      status: 'APPLIED',
      senderUsername: 'priya.scouts',
    }).integrationStatus(allSet);

    expect(out.everReceived).toBe(true);
    expect(out.totalMessages).toBe(5);
    expect(out.unmatchedMessages).toBe(2);
    expect(out.lastMessageAt).toBe(at);
    expect(out.lastMessageFrom).toBe('priya.scouts');
  });

  it('passes through which secrets are missing without exposing them', async () => {
    const out = await statusDeps(0, 0, null).integrationStatus({
      appSecret: true,
      verifyToken: true,
      accessToken: false,
    });
    expect(out.configured).toEqual({ appSecret: true, verifyToken: true, accessToken: false });
    // Presence is reported as booleans, so a secret's value can never ride
    // along in this response.
    for (const value of Object.values(out.configured)) {
      expect(typeof value).toBe('boolean');
    }
  });

  describe('recordDelivery', () => {
    const flags = allSet;

    it('reports no attempt before Meta has ever called', async () => {
      const out = await statusDeps(0, 0, null).integrationStatus(flags);
      expect(out.lastDeliveryAttempt).toBeNull();
    });

    it('surfaces a rejected delivery, which stores no message row', async () => {
      const s = statusDeps(0, 0, null);
      s.recordDelivery('rejected_bad_signature', 'wrong secret');
      const out = await s.integrationStatus(flags);
      // The distinction that matters: Meta DID call, it was just turned away.
      expect(out.everReceived).toBe(false);
      expect(out.webhookDeliveries).toBe(1);
      expect(out.lastDeliveryAttempt).toMatchObject({
        outcome: 'rejected_bad_signature',
        detail: 'wrong secret',
      });
    });

    it('keeps every attempt, reporting the most recent', async () => {
      const s = statusDeps(0, 0, null);
      s.recordDelivery('rejected_no_signature');
      s.recordDelivery('accepted', '1 message(s) received, 1 filed');
      const out = await s.integrationStatus(flags);
      expect(out.lastDeliveryAttempt?.outcome).toBe('accepted');
      // Both are kept: one call is the whole answer to "did Meta ever reach us".
      expect(out.webhookDeliveries).toBe(2);
    });

    it('never lets a failed diagnostic write break the webhook', async () => {
      const s = statusDeps(0, 0, null);
      const prisma = (
        s as unknown as { prisma: { instagramWebhookDelivery: { create: jest.Mock } } }
      ).prisma;
      prisma.instagramWebhookDelivery.create.mockRejectedValueOnce(new Error('db down'));
      // Meta retries anything that isn't a 200, so a diagnostic must never throw.
      expect(() => s.recordDelivery('accepted')).not.toThrow();
      await Promise.resolve();
    });
  });
});

describe('InstagramDmService.syncInbox', () => {
  const BIZ = 'BIZ_ID';

  function syncDeps(conversations: unknown, opts: { graphOk?: boolean; error?: string } = {}) {
    const prisma = {
      instagramMessage: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'm' }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'scout-1', instagramHandle: 'priya.scouts' }),
        update: jest.fn().mockResolvedValue({ id: 'scout-1', instagramHandle: 'priya.scouts' }),
      },
      scoutEntry: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'e1', rowNumber: 1 }),
        update: jest.fn().mockResolvedValue({ id: 'e1', rowNumber: 1 }),
      },
    } as unknown as PrismaService;

    const config = { get: jest.fn().mockReturnValue(24) } as unknown as ConfigService;
    const graph = {
      me: jest.fn().mockResolvedValue({ id: BIZ, username: 'influence__inc' }),
      fetchConversations: jest
        .fn()
        .mockResolvedValue(
          opts.graphOk === false
            ? { ok: false, error: opts.error ?? 'boom' }
            : { ok: true, body: { data: conversations } },
        ),
      lookupUsername: jest.fn().mockResolvedValue('priya.scouts'),
    } as unknown as InstagramGraphService;

    return { svc: new InstagramDmService(prisma, config, graph), prisma, graph };
  }

  const convo = (messages: unknown[]) => [{ id: 'c1', messages: { data: messages } }];

  it('reports the reason when Meta refuses the read, instead of throwing', async () => {
    const { svc } = syncDeps([], { graphOk: false, error: 'Invalid OAuth access token' });
    const out = await svc.syncInbox();
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Invalid OAuth access token');
    expect(out.filed).toBe(0);
  });

  it("files an incoming message and skips the account's own replies", async () => {
    const { svc, prisma } = syncDeps(
      convo([
        {
          id: 'm1',
          from: { id: 'IGSID_1', username: 'priya.scouts' },
          message: 'https://instagram.com/found',
        },
        { id: 'm2', from: { id: BIZ, username: 'influence__inc' }, message: 'thanks!' },
      ]),
    );
    const out = await svc.syncInbox();
    expect(out.messagesSeen).toBe(2);
    expect(out.ownMessagesSkipped).toBe(1);
    expect(out.filed).toBe(1);
    // The company's own reply must never become a scouting row.
    expect((prisma.scoutEntry.create as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('files a reel that the inbox returns as video media, with no text', async () => {
    const cdn = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=9&signature=s';
    const { svc, prisma } = syncDeps(
      convo([
        {
          id: 'm1',
          from: { id: 'IGSID_1' },
          attachments: { data: [{ video_data: { url: cdn } }] },
        },
      ]),
    );
    const out = await svc.syncInbox();
    expect(out.filed).toBe(1);
    expect((prisma.scoutEntry.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
      reelIdeas: cdn,
    });
  });

  it('counts a message it has already filed rather than filing it twice', async () => {
    const { svc, prisma } = syncDeps(
      convo([{ id: 'm1', from: { id: 'IGSID_1' }, message: 'https://instagram.com/found' }]),
    );
    (prisma.instagramMessage.findUnique as jest.Mock).mockResolvedValue({
      id: 'x',
      status: 'APPLIED',
      entryId: 'e1',
    });
    const out = await svc.syncInbox();
    expect(out.alreadyKnown).toBe(1);
    expect(out.filed).toBe(0);
    expect(prisma.scoutEntry.create).not.toHaveBeenCalled();
  });

  it('returns a sample message when it read some but could account for none', async () => {
    // So an unfamiliar payload shape can be inspected rather than guessed at.
    const { svc } = syncDeps(
      convo([{ id: 'm1', from: { id: 'IGSID_1' }, message: 'just saying hello' }]),
    );
    const out = await svc.syncInbox();
    expect(out.filed).toBe(0);
    expect(out.sample).toMatchObject({ id: 'm1' });
  });

  it('looks the account up once, not on every poll', async () => {
    const { svc, graph } = syncDeps(convo([]));
    await svc.syncInbox();
    await svc.syncInbox();
    await svc.syncInbox();
    // Polling every 35 seconds: a lookup per poll would double the calls
    // counted against Meta's rate limit for an id that never changes.
    expect(graph.me).toHaveBeenCalledTimes(1);
    expect(graph.fetchConversations).toHaveBeenCalledTimes(3);
  });

  it('retries the account lookup until it succeeds', async () => {
    const { svc, graph } = syncDeps(convo([]));
    (graph.me as jest.Mock).mockResolvedValueOnce(null);
    await svc.syncInbox();
    await svc.syncInbox();
    await svc.syncInbox();
    // A failed lookup must not be cached, or own messages would never be
    // recognised and skipped again.
    expect(graph.me).toHaveBeenCalledTimes(2);
  });

  it('does not dump a sample on a repeat run where everything is already filed', async () => {
    const { svc, prisma } = syncDeps(
      convo([{ id: 'm1', from: { id: 'IGSID_1' }, message: 'https://instagram.com/found' }]),
    );
    (prisma.instagramMessage.findUnique as jest.Mock).mockResolvedValue({
      id: 'x',
      status: 'APPLIED',
      entryId: 'e1',
    });
    const out = await svc.syncInbox();
    // Nothing filed, but nothing unexplained either — that's a normal re-run.
    expect(out.alreadyKnown).toBe(1);
    expect(out.sample).toBeUndefined();
  });

  it('ignores malformed entries without failing the whole run', async () => {
    const { svc } = syncDeps(
      convo([
        { message: 'no id or sender' },
        { id: 'm1', from: { id: 'IGSID_1' }, message: 'https://instagram.com/found' },
      ]),
    );
    const out = await svc.syncInbox();
    expect(out.ok).toBe(true);
    expect(out.messagesSeen).toBe(1);
    expect(out.filed).toBe(1);
  });
});

describe('InstagramDmService.diagnose', () => {
  type Reply = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

  /** A service whose Graph probes answer by path (and version, for inbox reads). */
  function withMeta(
    answer: (path: string, version?: string) => Reply,
    stored = { deliveries: 0, messages: 0 },
  ) {
    const prisma = {
      instagramWebhookDelivery: {
        count: jest.fn().mockResolvedValue(stored.deliveries),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      instagramMessage: { count: jest.fn().mockResolvedValue(stored.messages) },
    } as unknown as PrismaService;
    const probe = jest.fn((path: string, _params: unknown, version?: string) =>
      Promise.resolve(answer(path, version)),
    );
    const graph = { probe } as unknown as InstagramGraphService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    return { svc: new InstagramDmService(prisma, config, graph), probe };
  }

  const ME: Reply = {
    ok: true,
    body: {
      id: '1',
      user_id: '17841458298302705',
      username: 'influence__inc',
      account_type: 'BUSINESS',
    },
  };
  const SUBSCRIBED: Reply = { ok: true, body: { data: [{ subscribed_fields: ['messages'] }] } };
  const EMPTY: Reply = { ok: true, body: { data: [] } };
  const convoWith = (...names: string[]): Reply => ({
    ok: true,
    body: {
      data: [
        {
          participants: {
            data: [{ username: 'influence__inc' }, ...names.map((username) => ({ username }))],
          },
        },
      ],
    },
  });

  it('says plainly when Meta shows an empty inbox, and never blames our settings', async () => {
    const { svc } = withMeta((path) =>
      path === '/me' ? ME : path === '/me/subscribed_apps' ? SUBSCRIBED : EMPTY,
    );
    const d = await svc.diagnose();

    expect(d.inbox.map((p) => p.conversations)).toEqual([0, 0, 0]);
    expect(d.verdict[0]).toMatch(/EMPTY inbox for @influence__inc/);
    expect(d.verdict[1]).toMatch(/Tester invite/);
    expect(d.verdict.join(' ')).toMatch(/never called the webhook/);
  });

  it('asks three ways, including by the account id when Meta gives it as a string', async () => {
    const { svc, probe } = withMeta((path) =>
      path === '/me' ? ME : path === '/me/subscribed_apps' ? SUBSCRIBED : EMPTY,
    );
    await svc.diagnose();
    const inboxCalls = probe.mock.calls.filter(([path]) => String(path).endsWith('/conversations'));
    expect(inboxCalls.map(([path, , version]) => [path, version])).toEqual([
      ['/me/conversations', undefined],
      ['/me/conversations', 'v23.0'],
      ['/17841458298302705/conversations', 'v23.0'],
    ]);
  });

  it('points at our app when Meta answers one way but not the way the app asks', async () => {
    const { svc } = withMeta((path, version) => {
      if (path === '/me') return ME;
      if (path === '/me/subscribed_apps') return SUBSCRIBED;
      return version ? convoWith('tharun.fyi') : EMPTY;
    });
    const d = await svc.diagnose();
    expect(d.verdict[0]).toMatch(/DOES return 1 conversation/);
    expect(d.verdict[0]).toMatch(/problem in our app/);
    expect(d.inbox[1].participants).toEqual(['@tharun.fyi']);
  });

  it('lists who is in the inbox when reading works, leaving out the account itself', async () => {
    const { svc } = withMeta((path) =>
      path === '/me' ? ME : path === '/me/subscribed_apps' ? SUBSCRIBED : convoWith('tharun.fyi'),
    );
    const d = await svc.diagnose();
    expect(d.verdict[0]).toMatch(/Reading the inbox works/);
    expect(d.verdict[0]).toMatch(/@tharun\.fyi/);
    expect(d.verdict[0]).not.toMatch(/@influence__inc/);
  });

  it('flags an account that is not subscribed to message webhooks', async () => {
    const { svc } = withMeta((path) =>
      path === '/me'
        ? ME
        : path === '/me/subscribed_apps'
          ? { ok: true, body: { data: [{ subscribed_fields: ['comments'] }] } }
          : EMPTY,
    );
    const d = await svc.diagnose();
    expect(d.verdict.join(' ')).toMatch(
      /not subscribed to message webhooks \(subscribed: comments\)/,
    );
  });

  it('stops at a rejected token, since nothing else can be asked', async () => {
    const { svc } = withMeta((path) =>
      path === '/me' ? { ok: false, error: 'Error validating access token' } : EMPTY,
    );
    const d = await svc.diagnose();
    expect(d.verdict).toHaveLength(1);
    expect(d.verdict[0]).toMatch(/rejected the access token/);
    // Without an account id there is no third way to ask.
    expect(d.inbox).toHaveLength(2);
  });

  it('turns a permission error into the permission to add', async () => {
    const { svc } = withMeta((path) =>
      path === '/me'
        ? ME
        : path === '/me/subscribed_apps'
          ? SUBSCRIBED
          : { ok: false, error: '(#10) Application does not have permission for this action' },
    );
    const d = await svc.diagnose();
    expect(d.verdict[0]).toMatch(/instagram_business_manage_messages/);
  });
});
