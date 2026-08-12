import { ActivitySource } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreatorMergeService } from './creator-merge.service';

/**
 * Merge semantics for the split-creator repair: a handle-less record holding the
 * signer's contact + payout details folded into the master that holds the handle
 * and the performance history.
 */
describe('CreatorMergeService.merge', () => {
  // The master: handle + performance, but no contact details.
  const survivor = {
    id: 'master',
    instagramUsername: 'aibyjoe',
    creatorName: 'aibyjoe',
    email: null,
    phoneNumber: null,
    addressLine1: null,
    averageViews: 100000,
  };
  // The duplicate a handle-less contract created.
  const duplicate = {
    id: 'dupe',
    instagramUsername: null,
    creatorName: 'Joe Marquez',
    email: 'aibyjoe.ai@gmail.com',
    phoneNumber: '+1 555 0100',
    addressLine1: '12 Rue Lafayette',
    averageViews: null,
  };

  let tx: Record<string, any>;
  let activityLog: { record: jest.Mock };
  let service: CreatorMergeService;

  beforeEach(() => {
    tx = {
      creator: {
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve(
            where.id === 'master' ? survivor : where.id === 'dupe' ? duplicate : null,
          ),
        ),
        update: jest.fn(({ data }: any) => Promise.resolve({ ...survivor, ...data })),
        delete: jest.fn().mockResolvedValue(duplicate),
      },
      contract: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1),
      },
      creatorStats: {
        findMany: jest.fn(({ where }: any) =>
          Promise.resolve(
            where.creatorId === 'dupe'
              ? [{ id: 's1', statsCampaignId: 'camp-new' }]
              : [{ statsCampaignId: 'camp-old' }],
          ),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      emailHistory: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
        count: jest.fn().mockResolvedValue(3),
      },
      activityLog: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        count: jest.fn().mockResolvedValue(2),
      },
    };
    activityLog = { record: jest.fn() };
    const prisma = {
      $transaction: (cb: (t: unknown) => unknown) => cb(tx),
    } as unknown as PrismaService;
    service = new CreatorMergeService(prisma, activityLog as unknown as ActivityLogService);
  });

  it('moves every relation onto the survivor and deletes the duplicate', async () => {
    const res = await service.merge('master', 'dupe');

    expect(tx.contract.updateMany).toHaveBeenCalledWith({
      where: { creatorId: 'dupe' },
      data: { creatorId: 'master' },
    });
    expect(tx.emailHistory.updateMany).toHaveBeenCalled();
    expect(tx.activityLog.updateMany).toHaveBeenCalled();
    expect(tx.creator.delete).toHaveBeenCalledWith({ where: { id: 'dupe' } });
    expect(res.movedContracts).toBe(1);
    expect(res.dryRun).toBe(false);
  });

  it("fills the survivor's empty fields without overwriting the ones it has", async () => {
    await service.merge('master', 'dupe');

    const data = tx.creator.update.mock.calls[0][0].data;
    expect(data.email).toBe('aibyjoe.ai@gmail.com');
    expect(data.phoneNumber).toBe('+1 555 0100');
    expect(data.addressLine1).toBe('12 Rue Lafayette');
    // The survivor already has these — the thinner duplicate must not clobber them.
    expect(data.creatorName).toBeUndefined();
    expect(data.averageViews).toBeUndefined();
    expect(data.instagramUsername).toBeUndefined();
  });

  it('deletes the duplicate BEFORE writing its unique keys onto the survivor', async () => {
    await service.merge('master', 'dupe');

    // email is @unique — writing it while the duplicate still holds it would
    // violate the constraint.
    const deleteOrder = tx.creator.delete.mock.invocationCallOrder[0];
    const updateOrder = tx.creator.update.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(updateOrder);
  });

  it('drops duplicate stats for a campaign the survivor already has', async () => {
    tx.creatorStats.findMany = jest.fn(({ where }: any) =>
      Promise.resolve(
        where.creatorId === 'dupe'
          ? [
              { id: 's1', statsCampaignId: 'shared' },
              { id: 's2', statsCampaignId: 'fresh' },
            ]
          : [{ statsCampaignId: 'shared' }],
      ),
    );

    const res = await service.merge('master', 'dupe');

    // (creatorId, statsCampaignId) is unique, so the colliding row can't move.
    expect(res.movedStats).toBe(1);
    expect(res.droppedStats).toBe(1);
    expect(tx.creatorStats.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s1'] } } });
    expect(tx.creatorStats.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s2'] } },
      data: { creatorId: 'master' },
    });
  });

  it('writes nothing on a dry run but still reports the plan', async () => {
    const res = await service.merge('master', 'dupe', { dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.movedContracts).toBe(1);
    expect(res.filledFields.map((f) => f.field)).toContain('email');
    expect(tx.creator.delete).not.toHaveBeenCalled();
    expect(tx.creator.update).not.toHaveBeenCalled();
    expect(tx.contract.updateMany).not.toHaveBeenCalled();
    expect(activityLog.record).not.toHaveBeenCalled();
  });

  it('records the merge on the survivor for auditability', async () => {
    await service.merge('master', 'dupe', { source: ActivitySource.CONTRACT_SIGNED });

    expect(activityLog.record).toHaveBeenCalled();
    const [creatorId, changes, source] = activityLog.record.mock.calls[0];
    expect(creatorId).toBe('master');
    expect(source).toBe(ActivitySource.CONTRACT_SIGNED);
    expect(changes[0].field).toBe('merged');
  });

  it('refuses to merge a creator into itself', async () => {
    await expect(service.merge('master', 'master')).rejects.toThrow(/must differ/);
  });

  it('throws when either record is missing', async () => {
    await expect(service.merge('master', 'ghost')).rejects.toThrow(/not found/);
  });
});
