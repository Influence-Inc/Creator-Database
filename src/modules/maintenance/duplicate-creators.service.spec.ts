import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatorMergeService } from '../creators/creator-merge.service';
import { DuplicateCreatorsService } from './duplicate-creators.service';

/**
 * Pairing a handle-less duplicate with its master.
 *
 * The two rows share almost nothing by construction — if they had a field in
 * common they would never have split. So matches come in two grades: hard
 * identity evidence, which merges unattended, and a name sitting inside the
 * handle, which is only ever surfaced for a human to confirm.
 */
describe('DuplicateCreatorsService.find', () => {
  let prisma: Record<string, any>;
  let merger: { merge: jest.Mock };
  let service: DuplicateCreatorsService;

  const candidate = (over: Record<string, unknown> = {}) => ({
    id: 'dupe',
    creatorName: 'Joe Marquez',
    instagramUsername: null,
    email: 'aibyjoe.ai@gmail.com',
    threadId: null,
    phoneNumber: null,
    campaignName: null,
    contracts: [],
    ...over,
  });
  const master = (over: Record<string, unknown> = {}) => ({
    id: 'master',
    creatorName: 'aibyjoe',
    instagramUsername: 'aibyjoe',
    email: null,
    threadId: null,
    phoneNumber: null,
    campaignName: null,
    contracts: [],
    stats: [],
    ...over,
  });

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

  // -- the shape that actually exists in production -------------------------

  it('flags "Joe Marquez" against handle "aibyjoe" for review, not auto-merge', async () => {
    setup([candidate()], [master()]);

    const { pairs, counts } = await service.find();

    expect(pairs).toHaveLength(1);
    expect(pairs[0].survivor.id).toBe('master');
    expect(pairs[0].evidence).toContain('nameInHandle');
    // A name is a hint, not proof.
    expect(pairs[0].confidence).toBe('review');
    expect(counts.review).toBe(1);
    expect(counts.high).toBe(0);
  });

  it('flags "AIMAN GHAILAN" against handle "aiman.gn" (punctuation ignored)', async () => {
    setup(
      [candidate({ creatorName: 'AIMAN GHAILAN', email: 'aymaan.gn@gmail.com' })],
      [master({ id: 'm2', creatorName: 'aiman.gn', instagramUsername: 'aiman.gn' })],
    );

    const { pairs } = await service.find();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].evidence).toContain('nameInHandle');
  });

  it('picks up the signing form name when the creator row has none', async () => {
    setup(
      [candidate({ creatorName: null, contracts: [{ signerName: 'Joe Marquez' }] })],
      [master()],
    );

    const { pairs } = await service.find();
    expect(pairs[0].evidence).toContain('nameInHandle');
  });

  // -- hard evidence --------------------------------------------------------

  it('merges unattended when a contract signer email matches the master', async () => {
    setup(
      [candidate()],
      [master({ contracts: [{ signerEmail: 'aibyjoe.ai@gmail.com', signerPhone: null }] })],
    );

    const { pairs, counts } = await service.find();
    expect(pairs[0].confidence).toBe('high');
    expect(pairs[0].evidence).toContain('email');
    expect(counts.high).toBe(1);
  });

  it('treats an address we actually sent outreach to as hard evidence', async () => {
    setup([candidate()], [master()], [{ creatorId: 'master', recipient: 'AiByJoe.AI@Gmail.com' }]);

    const { pairs } = await service.find();
    expect(pairs[0].confidence).toBe('high');
    expect(pairs[0].evidence).toContain('email');
  });

  it('matches a phone regardless of formatting', async () => {
    setup(
      [candidate({ creatorName: null, email: null, phoneNumber: '+1 (555) 123-4567' })],
      [master({ phoneNumber: '15551234567' })],
    );

    const { pairs } = await service.find();
    expect(pairs[0].confidence).toBe('high');
    expect(pairs[0].evidence).toContain('phone');
  });

  it('prefers the hard match when one master matches by name and another by email', async () => {
    setup(
      [candidate()],
      [
        master({ id: 'byname', instagramUsername: 'aibyjoemusic', creatorName: 'aibyjoemusic' }),
        master({
          id: 'byemail',
          instagramUsername: 'unrelated',
          creatorName: 'unrelated',
          contracts: [{ signerEmail: 'aibyjoe.ai@gmail.com' }],
        }),
      ],
    );

    const { pairs } = await service.find();
    expect(pairs[0].survivor.id).toBe('byemail');
    expect(pairs[0].confidence).toBe('high');
  });

  // -- guards ---------------------------------------------------------------

  it('never matches on a shared campaign alone', async () => {
    // Dozens of creators run the same campaign — that is not identity.
    setup(
      [candidate({ creatorName: null, email: null, campaignName: 'Spring Drop' })],
      [master({ campaignName: 'Spring Drop' })],
    );

    const { pairs, unmatched } = await service.find();
    expect(pairs).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
  });

  it('reports a shared campaign as corroboration alongside a name match', async () => {
    setup(
      [candidate({ campaignName: 'Spring Drop' })],
      [master({ stats: [{ campaignName: 'Spring Drop' }] })],
    );

    const { pairs } = await service.find();
    expect(pairs[0].evidence).toEqual(expect.arrayContaining(['nameInHandle', 'sharedCampaign']));
    expect(pairs[0].sharedCampaigns).toEqual(['spring drop']);
  });

  it('downgrades to review and lists alternatives when several masters fit', async () => {
    setup(
      [candidate()],
      [master(), master({ id: 'master2', instagramUsername: 'joeyb', creatorName: 'joeyb' })],
    );

    const { pairs } = await service.find();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe('review');
    expect(pairs[0].alternatives).toHaveLength(1);
  });

  it('ignores name fragments too short or too generic to mean anything', async () => {
    setup(
      [candidate({ creatorName: 'Jo The Official', email: null })],
      [master({ instagramUsername: 'theofficialstore', creatorName: 'theofficialstore' })],
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

  // -- merging --------------------------------------------------------------

  it('mergeAll merges hard matches only and leaves name matches for a human', async () => {
    setup(
      [
        candidate({ id: 'hard', contracts: [{ signerEmail: 'hard@x.com' }] }),
        candidate({ id: 'soft', email: 'soft@x.com', creatorName: 'Joe Marquez' }),
      ],
      [
        master({
          id: 'm-hard',
          instagramUsername: 'hardguy',
          creatorName: 'hardguy',
          contracts: [{ signerEmail: 'hard@x.com' }],
        }),
        master(),
      ],
    );

    const res = await service.mergeAll(false);

    expect(res.matched).toBe(1);
    expect(res.needsReview).toBe(1);
    expect(merger.merge).toHaveBeenCalledTimes(1);
    expect(merger.merge).toHaveBeenCalledWith(
      'm-hard',
      'hard',
      expect.objectContaining({ dryRun: false }),
    );
  });

  it('mergeAll writes nothing on a dry run', async () => {
    setup([candidate()], [master({ contracts: [{ signerEmail: 'aibyjoe.ai@gmail.com' }] })]);

    const res = await service.mergeAll(true);
    expect(res.matched).toBe(1);
    expect(res.merged).toBe(0);
    expect(merger.merge).toHaveBeenCalledWith(
      'master',
      'dupe',
      expect.objectContaining({ dryRun: true }),
    );
  });
});
