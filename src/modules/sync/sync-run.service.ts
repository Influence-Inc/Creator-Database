import { Injectable } from '@nestjs/common';
import { JobType, SyncRun, SyncStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SyncCounters, SyncResult } from './sync-result.interface';

/**
 * Tracks each sync run in the `sync_runs` table for observability (when did a
 * job run, how many items did it touch, did it fail). Also formats the final
 * SyncResult returned to callers.
 */
@Injectable()
export class SyncRunService {
  constructor(private readonly prisma: PrismaService) {}

  start(jobType: JobType): Promise<SyncRun> {
    return this.prisma.syncRun.create({
      data: { jobType, status: SyncStatus.RUNNING },
    });
  }

  async succeed(run: SyncRun, counters: SyncCounters): Promise<SyncResult> {
    return this.close(run, SyncStatus.SUCCESS, counters);
  }

  async fail(run: SyncRun, counters: SyncCounters, error: string): Promise<SyncResult> {
    return this.close(run, SyncStatus.FAILED, counters, error);
  }

  private async close(
    run: SyncRun,
    status: SyncStatus,
    counters: SyncCounters,
    error?: string,
  ): Promise<SyncResult> {
    const finishedAt = new Date();
    const updated = await this.prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status,
        itemsProcessed: counters.processed,
        itemsCreated: counters.created,
        itemsUpdated: counters.updated,
        itemsFailed: counters.failed,
        error: error ?? null,
        finishedAt,
      },
    });

    return {
      runId: updated.id,
      jobType: updated.jobType,
      status: updated.status,
      itemsProcessed: updated.itemsProcessed,
      itemsCreated: updated.itemsCreated,
      itemsUpdated: updated.itemsUpdated,
      itemsFailed: updated.itemsFailed,
      error: updated.error ?? undefined,
      startedAt: updated.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - updated.startedAt.getTime(),
    };
  }
}
