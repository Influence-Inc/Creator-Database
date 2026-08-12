import { ActivitySource, Creator, NegotiationStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreatorMergeService } from './creator-merge.service';
import { CreatorsRepository } from './creators.repository';
import { CreatorsService } from './creators.service';

function makeCreator(overrides: Partial<Creator> = {}): Creator {
  return {
    id: 'creator-1',
    creatorName: null,
    instagramUsername: null,
    instagramProfileLink: null,
    email: null,
    phoneNumber: null,
    addressLine1: null,
    addressLine2: null,
    addressCity: null,
    addressState: null,
    addressPostalCode: null,
    addressCountry: null,
    campaignName: null,
    campaignId: null,
    outreachStage: null,
    assignedManager: null,
    averageViews: null,
    averageLikes: null,
    engagementRate: null,
    followers: null,
    riskLevel: null,
    cpm: null,
    acceptedRate: null,
    quotedRate: null,
    currency: 'USD',
    numberOfVideos: null,
    numberOfStories: null,
    numberOfReels: null,
    guaranteedViews: null,
    deadline: null,
    deliverablesDescription: null,
    latestEmailDate: null,
    lastReplyDate: null,
    threadId: null,
    emailStatus: null,
    inboxRate: null,
    spamRate: null,
    bounced: false,
    opened: false,
    replied: false,
    status: NegotiationStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('CreatorsService.upsertFromSource (merge logic)', () => {
  let service: CreatorsService;
  let repo: jest.Mocked<
    Pick<CreatorsRepository, 'findByEmail' | 'findByInstagram' | 'findByName' | 'create' | 'update'>
  >;
  let activityLog: { record: jest.Mock; findByCreator: jest.Mock };
  let merger: { merge: jest.Mock };

  beforeEach(() => {
    repo = {
      findByEmail: jest.fn(),
      findByInstagram: jest.fn(),
      findByName: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as typeof repo;

    activityLog = { record: jest.fn(), findByCreator: jest.fn() };
    merger = { merge: jest.fn() };

    const prisma = {
      // Execute the transaction callback synchronously with a dummy tx client.
      $transaction: (cb: (tx: unknown) => unknown) => cb({}),
    } as unknown as PrismaService;

    service = new CreatorsService(
      prisma,
      repo as unknown as CreatorsRepository,
      activityLog as unknown as ActivityLogService,
      merger as unknown as CreatorMergeService,
    );
  });

  it('creates a new creator when none matches', async () => {
    repo.findByEmail.mockResolvedValue(null);
    const created = makeCreator({ id: 'new', email: 'jane@example.com', creatorName: 'Jane Doe' });
    repo.create.mockResolvedValue(created);

    const result = await service.upsertFromSource(
      { email: 'jane@example.com', creatorName: 'Jane Doe' },
      ActivitySource.INSTANTLY_DASHBOARD,
    );

    expect(result.created).toBe(true);
    expect(result.creator).toBe(created);
    const createArg = repo.create.mock.calls[0][0];
    expect(createArg.email).toBe('jane@example.com');
    expect(createArg.creatorName).toBe('Jane Doe');
    expect(activityLog.record).toHaveBeenCalledWith(
      'new',
      [{ field: 'created', oldValue: null, newValue: expect.any(String) }],
      ActivitySource.INSTANTLY_DASHBOARD,
      expect.anything(),
    );
  });

  it('updates only the changed fields on an existing record', async () => {
    const existing = makeCreator({ id: '1', email: 'jane@example.com', cpm: 10 });
    repo.findByEmail.mockResolvedValue(existing);
    repo.update.mockResolvedValue({ ...existing, cpm: 20 });

    const result = await service.upsertFromSource(
      { email: 'jane@example.com', cpm: 20 },
      ActivitySource.INSTANTLY_DASHBOARD,
    );

    expect(result.created).toBe(false);
    expect(result.changed).toBe(true);
    const [id, data] = repo.update.mock.calls[0];
    expect(id).toBe('1');
    expect(data).toEqual({ cpm: 20 });
    const changes = activityLog.record.mock.calls[0][1];
    expect(changes).toEqual([{ field: 'cpm', oldValue: '10', newValue: '20' }]);
  });

  it('resolves by email before instagram (priority order)', async () => {
    // The record already has a handle, so identity resolution is settled by the
    // email match alone and instagram is never consulted.
    const existing = makeCreator({
      id: '1',
      email: 'jane@example.com',
      instagramUsername: 'existing_handle',
    });
    repo.findByEmail.mockResolvedValue(existing);

    const result = await service.upsertFromSource(
      { email: 'jane@example.com', instagramUsername: 'janedoe' },
      ActivitySource.INSTANTLY_DASHBOARD,
    );

    expect(result.creator?.id).toBe('1');
    expect(repo.findByEmail).toHaveBeenCalled();
    expect(repo.findByInstagram).not.toHaveBeenCalled();
  });

  it('skips upsert when no identity field is present', async () => {
    const result = await service.upsertFromSource({ cpm: 5 }, ActivitySource.INSTANTLY_DASHBOARD);

    expect(result.skipped).toBe(true);
    expect(result.creator).toBeNull();
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('fills an empty email on a record matched by instagram', async () => {
    const existing = makeCreator({ id: '2', instagramUsername: 'janedoe', email: null });
    repo.findByEmail.mockResolvedValue(null); // resolve + fill both see no owner
    repo.findByInstagram.mockResolvedValue(existing);
    repo.update.mockResolvedValue({ ...existing, email: 'new@example.com', cpm: 5 });

    const result = await service.upsertFromSource(
      { instagramUsername: 'janedoe', email: 'new@example.com', cpm: 5 },
      ActivitySource.CLAUDE_EXTRACTION,
    );

    expect(result.changed).toBe(true);
    const [, data] = repo.update.mock.calls[0];
    expect(data.email).toBe('new@example.com');
    expect(data.cpm).toBe(5);
    const changes = activityLog.record.mock.calls[0][1];
    expect(changes).toEqual(
      expect.arrayContaining([{ field: 'email', oldValue: null, newValue: 'new@example.com' }]),
    );
  });

  it('does not steal an instagram handle owned by a different creator', async () => {
    // Resolves by email (priority) to `emailOwner`; the handle "janedoe" already
    // belongs to a different creator, so the fill guard leaves it untouched.
    const handleOwner = makeCreator({ id: '3', instagramUsername: 'janedoe' });
    const emailOwner = makeCreator({ id: 'owner', email: 'taken@example.com' });
    repo.findByEmail.mockResolvedValue(emailOwner);
    repo.findByInstagram.mockResolvedValue(handleOwner);

    const result = await service.upsertFromSource(
      { instagramUsername: 'janedoe', email: 'taken@example.com' },
      ActivitySource.CLAUDE_EXTRACTION,
    );

    expect(result.changed).toBe(false);
    expect(repo.update).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// categorize — bulk classification (used / unused / new) for the Deal Studio
// badges. Backed by one repo call (findByIdentityKeys) and pure mapping logic.
// -----------------------------------------------------------------------------

describe('CreatorsService.categorize', () => {
  let service: CreatorsService;
  let repo: jest.Mocked<Pick<CreatorsRepository, 'findByIdentityKeys'>>;

  beforeEach(() => {
    repo = { findByIdentityKeys: jest.fn() } as unknown as typeof repo;
    const prisma = {} as unknown as PrismaService;
    const activityLog = {} as unknown as ActivityLogService;
    const merger = {} as unknown as CreatorMergeService;
    service = new CreatorsService(
      prisma,
      repo as unknown as CreatorsRepository,
      activityLog,
      merger,
    );
  });

  it('classifies a matched creator with contracts as used, no contracts as unused', async () => {
    repo.findByIdentityKeys.mockResolvedValue([
      { ...makeCreator({ id: 'c1', email: 'used@example.com' }), contractsCount: 2 },
      { ...makeCreator({ id: 'c2', instagramUsername: 'unused_ig' }), contractsCount: 0 },
    ]);

    const out = await service.categorize({
      keys: [
        { email: 'used@example.com' },
        { instagramUsername: 'unused_ig' },
      ],
    });

    expect(out[0].category).toBe('used');
    expect(out[0].creator?.contractsCount).toBe(2);
    expect(out[1].category).toBe('unused');
    expect(out[1].creator?.contractsCount).toBe(0);
  });

  it('returns new for keys that do not match any creator', async () => {
    repo.findByIdentityKeys.mockResolvedValue([]);
    const out = await service.categorize({ keys: [{ email: 'nobody@example.com' }] });
    expect(out[0].category).toBe('new');
    expect(out[0].creator).toBeNull();
  });

  it('normalizes emails (case + trim) and IG handles (@, URL) before matching', async () => {
    // The repo is called with normalized keys; verify each recognizable shape
    // collapses to the canonical form the master record is stored under.
    repo.findByIdentityKeys.mockResolvedValue([
      { ...makeCreator({ id: 'c1', email: 'alex@example.com', instagramUsername: 'alexcreates' }), contractsCount: 1 },
    ]);

    await service.categorize({
      keys: [
        { email: '  Alex@Example.COM ' },
        { instagramUsername: '@AlexCreates' },
        { instagramUsername: 'https://www.instagram.com/AlexCreates/' },
      ],
    });

    const args = repo.findByIdentityKeys.mock.calls[0][0] as {
      email: string | null;
      instagramUsername: string | null;
    }[];
    expect(args[0].email).toBe('alex@example.com');
    expect(args[1].instagramUsername).toBe('alexcreates');
    expect(args[2].instagramUsername).toBe('alexcreates');
  });

  it('preserves input order — response is positional', async () => {
    // Different keys in the response's order (not the DB's) — the caller
    // relies on this to line the result up with its own array.
    repo.findByIdentityKeys.mockResolvedValue([
      { ...makeCreator({ id: 'c1', email: 'a@x.com' }), contractsCount: 3 },
    ]);
    const out = await service.categorize({
      keys: [
        { email: 'nobody@x.com' },
        { email: 'a@x.com' },
        { email: 'another@x.com' },
      ],
    });
    expect(out.map((r) => r.category)).toEqual(['new', 'used', 'new']);
  });
});

/**
 * The duplicate-creator bug: a signed contract that arrived without an Instagram
 * handle created a second record holding the signer's contact + payout details.
 * Re-syncing that contract now carries BOTH keys, which resolve to two different
 * records — the signal that they are one person and must be folded together.
 */
describe('CreatorsService.upsertFromSource (identity split)', () => {
  let service: CreatorsService;
  let repo: jest.Mocked<
    Pick<CreatorsRepository, 'findByEmail' | 'findByInstagram' | 'findByName' | 'create' | 'update'>
  >;
  let activityLog: { record: jest.Mock; findByCreator: jest.Mock };
  let merger: { merge: jest.Mock };

  // The master: has the handle + performance history, never got an email.
  const master = makeCreator({ id: 'master', instagramUsername: 'aibyjoe', averageViews: 100000 });
  // The duplicate the handle-less contract created: contact details, no handle.
  const dupe = makeCreator({ id: 'dupe', email: 'aibyjoe.ai@gmail.com', creatorName: 'Joe' });

  beforeEach(() => {
    repo = {
      findByEmail: jest.fn(),
      findByInstagram: jest.fn(),
      findByName: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as typeof repo;
    activityLog = { record: jest.fn(), findByCreator: jest.fn() };
    merger = { merge: jest.fn() };
    const prisma = {
      $transaction: (cb: (tx: unknown) => unknown) => cb({}),
    } as unknown as PrismaService;
    service = new CreatorsService(
      prisma,
      repo as unknown as CreatorsRepository,
      activityLog as unknown as ActivityLogService,
      merger as unknown as CreatorMergeService,
    );
  });

  it('merges when the email and handle resolve to different creators', async () => {
    repo.findByEmail.mockResolvedValue(dupe);
    repo.findByInstagram.mockResolvedValue(master);
    const mergedSurvivor = { ...master, email: 'aibyjoe.ai@gmail.com' };
    merger.merge.mockResolvedValue({ survivor: mergedSurvivor });
    repo.update.mockResolvedValue(mergedSurvivor);

    const result = await service.upsertFromSource(
      { email: 'aibyjoe.ai@gmail.com', instagramUsername: 'aibyjoe', creatorName: 'Joe Marquez' },
      ActivitySource.CONTRACT_SIGNED,
    );

    // The handle-holder survives; the handle-less duplicate is folded in.
    expect(merger.merge).toHaveBeenCalledWith(
      'master',
      'dupe',
      { source: ActivitySource.CONTRACT_SIGNED },
      expect.anything(),
    );
    expect(result.creator?.id).toBe('master');
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('does not merge on an LLM extraction — only first-hand identity sources', async () => {
    repo.findByEmail.mockResolvedValue(dupe);
    repo.findByInstagram.mockResolvedValue(master);
    repo.update.mockResolvedValue(dupe);

    await service.upsertFromSource(
      { email: 'aibyjoe.ai@gmail.com', instagramUsername: 'aibyjoe' },
      ActivitySource.CLAUDE_EXTRACTION,
    );

    expect(merger.merge).not.toHaveBeenCalled();
  });

  it('does not merge when the email already owns a DIFFERENT handle (agency address)', async () => {
    // One manager address fronting two creators: the email match already has its
    // own handle, so the payload is naming a second, distinct creator — merging
    // here would destroy a real record.
    const managed = makeCreator({
      id: 'managed',
      email: 'agency@example.com',
      instagramUsername: 'creator_one',
    });
    repo.findByEmail.mockResolvedValue(managed);
    repo.findByInstagram.mockResolvedValue(
      makeCreator({ id: 'other', instagramUsername: 'creator_two' }),
    );
    repo.update.mockResolvedValue(managed);

    const result = await service.upsertFromSource(
      { email: 'agency@example.com', instagramUsername: 'creator_two' },
      ActivitySource.CONTRACT_SIGNED,
    );

    expect(merger.merge).not.toHaveBeenCalled();
    expect(result.creator?.id).toBe('managed');
  });

  it('does not merge when both keys resolve to the same creator', async () => {
    repo.findByEmail.mockResolvedValue(master);
    repo.findByInstagram.mockResolvedValue(master);
    repo.update.mockResolvedValue(master);

    await service.upsertFromSource(
      { email: 'joe@example.com', instagramUsername: 'aibyjoe' },
      ActivitySource.CONTRACT_SIGNED,
    );

    expect(merger.merge).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('still creates a creator when neither key matches anything', async () => {
    repo.findByEmail.mockResolvedValue(null);
    repo.findByInstagram.mockResolvedValue(null);
    repo.findByName.mockResolvedValue(null);
    repo.create.mockResolvedValue(makeCreator({ id: 'fresh' }));

    const result = await service.upsertFromSource(
      { email: 'new@example.com', instagramUsername: 'brandnew' },
      ActivitySource.CONTRACT_SIGNED,
    );

    expect(merger.merge).not.toHaveBeenCalled();
    expect(result.created).toBe(true);
    expect(result.creator?.id).toBe('fresh');
  });

  it('falls back to the handle when only it matches', async () => {
    repo.findByEmail.mockResolvedValue(null);
    repo.findByInstagram.mockResolvedValue(master);
    repo.update.mockResolvedValue(master);

    const result = await service.upsertFromSource(
      { email: 'unknown@example.com', instagramUsername: 'aibyjoe' },
      ActivitySource.CONTRACT_SIGNED,
    );

    expect(merger.merge).not.toHaveBeenCalled();
    expect(result.creator?.id).toBe('master');
  });
});
