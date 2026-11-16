import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CHURN_CUTOFF, CHURN_FIELDS, RetentionService } from './retention.service';

function make(opts: { failedBefore: number; deleted: [number, number, number] }) {
  const exec = jest
    .fn()
    .mockResolvedValueOnce(opts.deleted[0])
    .mockResolvedValueOnce(opts.deleted[1])
    .mockResolvedValueOnce(opts.deleted[2])
    .mockResolvedValue(0);
  const queryUnsafe = jest.fn().mockResolvedValue([{ n: BigInt(opts.failedBefore) }]);
  const query = jest
    .fn()
    .mockResolvedValueOnce([
      { table: 'failed_jobs', rows: BigInt(10), total_bytes: BigInt(1024), total: '1 kB' },
    ])
    .mockResolvedValueOnce([{ size: '100 MB' }]);
  const prisma = {
    $executeRawUnsafe: exec,
    $queryRawUnsafe: queryUnsafe,
    $queryRaw: query,
  } as unknown as PrismaService;
  const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
  const svc = new RetentionService(prisma, config, {} as SchedulerRegistry);
  return { svc, exec, queryUnsafe };
}

describe('RetentionService.prune', () => {
  it('dry run only counts', async () => {
    const { svc, exec, queryUnsafe } = make({ failedBefore: 5, deleted: [0, 0, 0] });
    const res = await svc.prune(true, { collapseChurn: false });

    expect(exec).not.toHaveBeenCalled();
    expect(queryUnsafe).toHaveBeenCalledTimes(3);
    expect(res).toEqual({
      dryRun: true,
      deleted: { failed_jobs: 5, sync_runs: 5, instagram_webhook_deliveries: 5 },
      compacted: [],
    });
  });

  it('only ever deletes from the three log tables', async () => {
    const { svc, exec } = make({ failedBefore: 100, deleted: [10, 2, 3] });
    await svc.prune(false, { collapseChurn: false });

    const deletes = exec.mock.calls
      .map((c) => c[0] as string)
      .filter((s) => s.startsWith('DELETE'));
    expect(deletes).toHaveLength(3);
    expect(deletes[0]).toMatch(/^DELETE FROM failed_jobs WHERE/);
    expect(deletes[1]).toMatch(/^DELETE FROM sync_runs WHERE/);
    expect(deletes[2]).toMatch(/^DELETE FROM instagram_webhook_deliveries WHERE/);
  });

  it('removes old-style full-payload dead letters regardless of age', async () => {
    const { svc, exec } = make({ failedBefore: 100, deleted: [10, 0, 0] });
    await svc.prune(false, { collapseChurn: false });
    const sql = exec.mock.calls[0][0] as string;
    expect(sql).toContain("payload ? 'lead'");
    expect(sql).toContain("jsonb_typeof(payload -> 'email') = 'object'");
  });

  it('VACUUM FULLs failed_jobs when most of it was removed', async () => {
    const { svc, exec } = make({ failedBefore: 100, deleted: [90, 0, 0] });
    const res = await svc.prune(false, { collapseChurn: false });

    expect(exec).toHaveBeenCalledWith('VACUUM FULL failed_jobs');
    expect(res.compacted).toEqual(['failed_jobs']);
    expect(res.databaseSize).toBe('100 MB');
  });

  it('plain VACUUMs when only a little was removed', async () => {
    const { svc, exec } = make({ failedBefore: 100, deleted: [5, 1, 0] });
    const res = await svc.prune(false, { collapseChurn: false });

    expect(exec).toHaveBeenCalledWith('VACUUM failed_jobs');
    expect(exec).toHaveBeenCalledWith('VACUUM sync_runs');
    expect(exec).not.toHaveBeenCalledWith('VACUUM FULL failed_jobs');
    expect(res.compacted).toEqual([]);
  });
});

describe('RetentionService churn collapse', () => {
  function makeChurn(deletedPerCreator: number, estimatedRows: number) {
    const exec = jest
      .fn()
      .mockImplementation((sql: string) =>
        Promise.resolve(sql.startsWith('DELETE FROM activity_logs') ? deletedPerCreator : 0),
      );
    const queryUnsafe = jest
      .fn()
      .mockImplementation((sql: string) =>
        Promise.resolve(sql.includes('reltuples') ? [{ n: estimatedRows }] : [{ n: BigInt(0) }]),
      );
    const prisma = {
      $executeRawUnsafe: exec,
      $queryRawUnsafe: queryUnsafe,
      $queryRaw: jest.fn().mockResolvedValue([{ size: '1 MB' }]),
      creator: { findMany: jest.fn().mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]) },
    } as unknown as PrismaService;
    const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    return { svc: new RetentionService(prisma, config, {} as SchedulerRegistry), exec };
  }

  it('deletes per creator, keeping the newest pre-cutoff row of each sync field', async () => {
    const { svc, exec } = makeChurn(10, 1000);
    const res = await svc.prune(false);

    const churn = exec.mock.calls.filter((c) =>
      (c[0] as string).startsWith('DELETE FROM activity_logs'),
    );
    expect(churn).toHaveLength(2);
    const [sql, creatorId, cutoff] = churn[0];
    expect(creatorId).toBe('c1');
    expect(cutoff).toEqual(CHURN_CUTOFF);
    expect(sql).toContain('max("createdAt") AS keep_at');
    expect(sql).toContain('a."createdAt" < k.keep_at');
    expect(sql).toContain("'INSTANTLY_DASHBOARD', 'STATS_SYNC'");
    for (const field of CHURN_FIELDS) expect(sql).toContain(`'${field}'`);
    expect(res.deleted.activity_logs).toBe(20);
  });

  it('VACUUM FULLs activity_logs when most of it was churn', async () => {
    const { svc, exec } = makeChurn(400, 1000);
    const res = await svc.prune(false);
    expect(exec).toHaveBeenCalledWith('VACUUM FULL activity_logs');
    expect(res.compacted).toContain('activity_logs');
  });

  it('dry run deletes nothing', async () => {
    const { svc, exec } = makeChurn(10, 1000);
    await svc.prune(true);
    expect(exec).not.toHaveBeenCalled();
  });
});
