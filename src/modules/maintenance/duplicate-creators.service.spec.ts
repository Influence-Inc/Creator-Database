import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatorMergeService } from '../creators/creator-merge.service';
import { DuplicateCreatorsService } from './duplicate-creators.service';

/**
 * Pairing a handle-less duplicate with its master. The bar is deliberately high:
 * only hard evidence (an email we actually sent, a shared thread, a shared
 * phone) pairs two records — never a name resemblance.
 */
describe('DuplicateCreatorsService.find', () => {
  let prisma: Record<string, any>;
  let merger: { merge: jest.Mock };
  let service: DuplicateCreatorsService;

  const candidate = (over: Record<string, unknown> = {}) => ({
    id: 'dupe',
    creatorName: 'Joe',
    email: 'aibyjoe.ai@gmail.com',
    threadId: null,
    phoneNumber: null,
    _count: { contracts: 1 },
    ...over,
  });
  const master = (over: Record<string, unknown> = {}) => ({
    id: 'master',
    creatorName: 'aibyjoe',
    instagramUsername: 'aibyjoe',
    threadId: null,
    phoneNumber: null,
    ...over,
  });

  /** creators.findMany is called twice: candidates, then masters. */
  const setup = (candidates: unknown[], masters: unknown[], emails: unknown[] = []) => {
    prisma = {
      creator: {
        findMany: jest.fn().mockResolvedValueOnce(candidates).mockResolvedValueOnce(masters),
      },
      emailHistory: { findMany: jest.fn().mockResolvedValue(emails) },
    };
    merger = { merge: jest.fn().mockResolvedValue({ survivorId: 'master', duplicateId: 'dupe' }) };
    service = new DuplicateCreatorsService(
      prisma as unknown as PrismaService,
      merger as unknown as CreatorMergeService,
    );
  };

  it('pairs on an email we actually sent to the master', async () => {
    setup([candidate()], [master()], [{ creatorId: 'master', recipient: 'aibyjoe.ai@gmail.com' }]);

    const { pairs, unmatched } = await service.find();

    expect(pairs).toHaveLength(1);
    expect(pairs[0].survivor.id).toBe('master');
    expect(pairs[0].duplicate.id).toBe('dupe');
    expect(pairs[0].evidence).toEqual(['email']);
    expect(unmatched).toHaveLength(0);
  });

  it('matches recipients case-insensitively', async () => {
    setup(
      [candidate({ email: 'AiByJoe.AI@Gmail.com' })],
      [master()],
      [{ creatorId: 'master', recipient: 'aibyjoe.ai@gmail.com' }],
    );

    const { pairs } = await service.find();
    expect(pairs).toHaveLength(1);
  });

  it('pairs on a shared outreach thread', async () => {
    setup([candidate({ email: null, threadId: 'thread-9' })], [master({ threadId: 'thread-9' })]);

    const { pairs } = await service.find();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].evidence).toEqual(['threadId']);
  });

  it('pairs on a phone number regardless of formatting', async () => {
    setup(
      [candidate({ email: null, phoneNumber: '+1 (555) 123-4567' })],
      [master({ phoneNumber: '15551234567' })],
    );

    const { pairs } = await service.find();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].evidence).toEqual(['phone']);
  });

  it('never pairs on a name resemblance alone', async () => {
    // Same first name, and nothing else in common — not evidence.
    setup([candidate({ email: 'someone@else.com' })], [master({ creatorName: 'Joe' })]);

    const { pairs, unmatched } = await service.find();
    expect(pairs).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
  });

  it('leaves a duplicate unmatched when two masters both fit', async () => {
    setup(
      [candidate({ threadId: 'shared-thread' })],
      [
        master(),
        master({ id: 'master2', instagramUsername: 'someoneelse', threadId: 'shared-thread' }),
      ],
      [{ creatorId: 'master', recipient: 'aibyjoe.ai@gmail.com' }],
    );

    const { pairs, unmatched } = await service.find();
    // email → master, thread → master2. Ambiguous, so a human decides.
    expect(pairs).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
  });

  it('ignores an address that reached two different masters (shared inbox)', async () => {
    setup(
      [candidate()],
      [master(), master({ id: 'master2', instagramUsername: 'other' })],
      [
        { creatorId: 'master', recipient: 'aibyjoe.ai@gmail.com' },
        { creatorId: 'master2', recipient: 'aibyjoe.ai@gmail.com' },
      ],
    );

    const { pairs, unmatched } = await service.find();
    expect(pairs).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
  });

  it('short-circuits when there are no handle-less records', async () => {
    setup([], [master()]);

    const { pairs, unmatched } = await service.find();
    expect(pairs).toHaveLength(0);
    expect(unmatched).toHaveLength(0);
    expect(prisma.emailHistory.findMany).not.toHaveBeenCalled();
  });

  it('mergeAll defaults to reporting, and only writes when told to', async () => {
    setup([candidate()], [master()], [{ creatorId: 'master', recipient: 'aibyjoe.ai@gmail.com' }]);

    const dry = await service.mergeAll(true);
    expect(dry.matched).toBe(1);
    expect(dry.merged).toBe(0);
    expect(merger.merge).toHaveBeenCalledWith(
      'master',
      'dupe',
      expect.objectContaining({ dryRun: true }),
    );
  });
});
