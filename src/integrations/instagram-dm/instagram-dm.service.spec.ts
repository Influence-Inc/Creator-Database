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
