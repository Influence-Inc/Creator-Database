import { JobType, SyncStatus } from '@prisma/client';

/** Summary returned by every sync job (and by the manual sync endpoints). */
export interface SyncResult {
  runId: string;
  jobType: JobType;
  status: SyncStatus;
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsFailed: number;
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/** Mutable counters accumulated while a job runs. */
export interface SyncCounters {
  processed: number;
  created: number;
  updated: number;
  failed: number;
}

export function emptyCounters(): SyncCounters {
  return { processed: 0, created: 0, updated: 0, failed: 0 };
}
