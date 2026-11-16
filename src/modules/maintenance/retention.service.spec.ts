import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RetentionService } from './retention.service';

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
    const res = await svc.prune(true);

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
    await svc.prune(false);

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
    await svc.prune(false);
    const sql = exec.mock.calls[0][0] as string;
    expect(sql).toContain("payload ? 'lead'");
    expect(sql).toContain("jsonb_typeof(payload -> 'email') = 'object'");
  });

  it('VACUUM FULLs failed_jobs when most of it was removed', async () => {
    const { svc, exec } = make({ failedBefore: 100, deleted: [90, 0, 0] });
    const res = await svc.prune(false);

    expect(exec).toHaveBeenCalledWith('VACUUM FULL failed_jobs');
    expect(res.compacted).toEqual(['failed_jobs']);
    expect(res.databaseSize).toBe('100 MB');
  });

  it('plain VACUUMs when only a little was removed', async () => {
    const { svc, exec } = make({ failedBefore: 100, deleted: [5, 1, 0] });
    const res = await svc.prune(false);

    expect(exec).toHaveBeenCalledWith('VACUUM failed_jobs');
    expect(exec).toHaveBeenCalledWith('VACUUM sync_runs');
    expect(exec).not.toHaveBeenCalledWith('VACUUM FULL failed_jobs');
    expect(res.compacted).toEqual([]);
  });
});
