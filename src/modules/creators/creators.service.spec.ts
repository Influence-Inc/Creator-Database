import { ActivitySource, Creator, NegotiationStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
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

  beforeEach(() => {
    repo = {
      findByEmail: jest.fn(),
      findByInstagram: jest.fn(),
      findByName: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as typeof repo;

    activityLog = { record: jest.fn(), findByCreator: jest.fn() };

    const prisma = {
      // Execute the transaction callback synchronously with a dummy tx client.
      $transaction: (cb: (tx: unknown) => unknown) => cb({}),
    } as unknown as PrismaService;

    service = new CreatorsService(
      prisma,
      repo as unknown as CreatorsRepository,
      activityLog as unknown as ActivityLogService,
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
    service = new CreatorsService(prisma, repo as unknown as CreatorsRepository, activityLog);
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
