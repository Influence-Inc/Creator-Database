import { MaintenanceService } from './maintenance.service';
import { PrismaService } from '../../common/prisma/prisma.service';

function makePrisma(matched: unknown[], demoCampaign: unknown = null) {
  return {
    creator: {
      findMany: jest.fn().mockResolvedValue(matched),
      deleteMany: jest.fn().mockResolvedValue({ count: matched.length }),
    },
    campaign: {
      findFirst: jest.fn().mockResolvedValue(demoCampaign),
      delete: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
}

describe('MaintenanceService.purgeDemo', () => {
  const rows = [{ id: '1', creatorName: 'Demo Creator', email: 'demo.creator@example.com', instagramUsername: 'democreator' }];

  it('dry run reports matches without deleting', async () => {
    const prisma = makePrisma(rows);
    const svc = new MaintenanceService(prisma);
    const res = await svc.purgeDemo(true);

    expect(res).toEqual({ dryRun: true, matchedCount: 1, matched: rows });
    expect((prisma as any).creator.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes demo creators using conservative markers only', async () => {
    const prisma = makePrisma(rows);
    const svc = new MaintenanceService(prisma);
    const res = await svc.purgeDemo(false);

    expect((prisma as any).creator.deleteMany).toHaveBeenCalledTimes(1);
    const where = (prisma as any).creator.deleteMany.mock.calls[0][0].where;
    // Only the demo markers — never an unconditional wipe.
    expect(where.OR).toEqual([
      { email: { endsWith: '@example.com', mode: 'insensitive' } },
      { instagramUsername: { in: ['democreator', 'demo_creator'] } },
      { creatorName: { in: ['Demo Creator', 'Test Creator'], mode: 'insensitive' } },
    ]);
    expect(res.deletedCount).toBe(1);
    expect(res.deleted).toEqual(rows);
  });

  it('removes the seed demo campaign only when it has no creators left', async () => {
    const prisma = makePrisma(rows, { id: 'c1', _count: { creators: 0 } });
    const svc = new MaintenanceService(prisma);
    const res = await svc.purgeDemo(false);
    expect((prisma as any).campaign.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    expect(res.campaignRemoved).toBe(true);
  });

  it('keeps a demo campaign that still has creators', async () => {
    const prisma = makePrisma(rows, { id: 'c1', _count: { creators: 3 } });
    const svc = new MaintenanceService(prisma);
    const res = await svc.purgeDemo(false);
    expect((prisma as any).campaign.delete).not.toHaveBeenCalled();
    expect(res.campaignRemoved).toBe(false);
  });
});
