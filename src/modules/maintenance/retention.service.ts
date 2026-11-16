import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';

/** First pass runs this long after boot, once the background migration is done. */
const FIRST_RUN_DELAY_MS = 90_000;
/** Then every six hours. */
const RUN_EVERY_MS = 6 * 3600 * 1000;

export interface TableSize {
  table: string;
  rows: number;
  totalBytes: number;
  total: string;
}

export interface PruneResult {
  dryRun: boolean;
  /** Rows removed (or that would be removed) per table. */
  deleted: Record<string, number>;
  /** Tables whose disk was handed back to the OS with VACUUM FULL. */
  compacted: string[];
  databaseSize?: string;
}

/**
 * Keeps the operational log tables from growing without limit.
 *
 * `failed_jobs`, `sync_runs` and `instagram_webhook_deliveries` are written by
 * background work that runs every few minutes forever, and nothing ever removed
 * a row. `failed_jobs` was the worst: every failing email/lead was re-inserted
 * every run with its full raw payload, which is what filled the Postgres volume.
 * DeadLetterService now dedupes and stores small payloads; this cleans up what
 * is already there and stops the rest from creeping.
 *
 * What is pruned:
 *   - failed_jobs older than RETENTION_FAILED_JOB_DAYS (default 14), plus any
 *     row still carrying an old-style full email/lead payload — those are
 *     re-recorded compactly the next time the item fails, so nothing is lost;
 *   - sync_runs and instagram_webhook_deliveries older than RETENTION_LOG_DAYS
 *     (default 30).
 *
 * Business data (creators, contracts, stats, email history, scout sheets,
 * Instagram messages, activity logs) is never touched.
 *
 * A plain DELETE only marks space reusable inside the table. When a large share
 * of `failed_jobs` goes, it is rewritten with VACUUM FULL so the space actually
 * returns to the volume; that rewrite only needs room for the rows that remain,
 * which after the purge is tiny.
 */
@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly logger = new Logger(RetentionService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (!this.config.get<boolean>('jobs.enableScheduler')) return;

    const first = setTimeout(() => void this.runQuietly(), FIRST_RUN_DELAY_MS);
    first.unref?.();
    this.schedulerRegistry.addTimeout('retention-first-run', first);

    const every = setInterval(() => void this.runQuietly(), RUN_EVERY_MS);
    every.unref?.();
    this.schedulerRegistry.addInterval('retention', every);
  }

  private failedJobDays(): number {
    return Math.max(1, this.config.get<number>('jobs.retentionFailedJobDays') ?? 14);
  }

  private logDays(): number {
    return Math.max(1, this.config.get<number>('jobs.retentionLogDays') ?? 30);
  }

  private async runQuietly(): Promise<void> {
    try {
      await this.prune(false);
    } catch (err) {
      this.logger.error(
        `Retention run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Largest tables first, with row estimates — the "where did the disk go" view. */
  async tableSizes(): Promise<{ databaseSize: string; tables: TableSize[] }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ table: string; rows: bigint | number; total_bytes: bigint | number; total: string }>
    >`
      SELECT c.relname AS "table",
             GREATEST(c.reltuples, 0)::bigint AS "rows",
             pg_total_relation_size(c.oid) AS "total_bytes",
             pg_size_pretty(pg_total_relation_size(c.oid)) AS "total"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname = current_schema()
       ORDER BY pg_total_relation_size(c.oid) DESC
    `;
    const [{ size }] = await this.prisma.$queryRaw<Array<{ size: string }>>`
      SELECT pg_size_pretty(pg_database_size(current_database())) AS size
    `;
    return {
      databaseSize: size,
      tables: rows.map((r) => ({
        table: r.table,
        rows: Number(r.rows),
        totalBytes: Number(r.total_bytes),
        total: r.total,
      })),
    };
  }

  async prune(dryRun = false): Promise<PruneResult> {
    if (this.running) {
      return { dryRun, deleted: {}, compacted: [] };
    }
    this.running = true;
    try {
      return await this.doPrune(dryRun);
    } finally {
      this.running = false;
    }
  }

  private async doPrune(dryRun: boolean): Promise<PruneResult> {
    const failedCutoff = new Date(Date.now() - this.failedJobDays() * 86400_000);
    const logCutoff = new Date(Date.now() - this.logDays() * 86400_000);

    // Old-style dead letters stored the whole Instantly email (`email` as an
    // object) or lead (`lead`). The stats job's `email` is a plain string, so
    // the jsonb_typeof check leaves those alone.
    const bloatedFailedJobs = `
      "createdAt" < $1
      OR payload ? 'lead'
      OR jsonb_typeof(payload -> 'email') = 'object'`;

    const deleted: Record<string, number> = {};
    if (dryRun) {
      deleted.failed_jobs = await this.count('failed_jobs', bloatedFailedJobs, failedCutoff);
      deleted.sync_runs = await this.count('sync_runs', '"startedAt" < $1', logCutoff);
      deleted.instagram_webhook_deliveries = await this.count(
        'instagram_webhook_deliveries',
        '"at" < $1',
        logCutoff,
      );
      return { dryRun, deleted, compacted: [] };
    }

    const failedBefore = await this.count('failed_jobs', 'TRUE');
    deleted.failed_jobs = await this.prisma.$executeRawUnsafe(
      `DELETE FROM failed_jobs WHERE ${bloatedFailedJobs}`,
      failedCutoff,
    );
    deleted.sync_runs = await this.prisma.$executeRawUnsafe(
      'DELETE FROM sync_runs WHERE "startedAt" < $1',
      logCutoff,
    );
    deleted.instagram_webhook_deliveries = await this.prisma.$executeRawUnsafe(
      'DELETE FROM instagram_webhook_deliveries WHERE "at" < $1',
      logCutoff,
    );

    const compacted: string[] = [];
    // Hand the space back to the volume when a big share of the table went.
    if (deleted.failed_jobs > 0 && deleted.failed_jobs >= failedBefore / 2) {
      if (await this.vacuum('failed_jobs', true)) compacted.push('failed_jobs');
    } else if (deleted.failed_jobs > 0) {
      await this.vacuum('failed_jobs', false);
    }
    if (deleted.sync_runs > 0) await this.vacuum('sync_runs', false);
    if (deleted.instagram_webhook_deliveries > 0) {
      await this.vacuum('instagram_webhook_deliveries', false);
    }

    let databaseSize: string | undefined;
    try {
      const sizes = await this.tableSizes();
      databaseSize = sizes.databaseSize;
      const top = sizes.tables
        .slice(0, 5)
        .map((t) => `${t.table}=${t.total}`)
        .join(', ');
      this.logger.log(
        `Retention: removed ${deleted.failed_jobs} failed_jobs, ${deleted.sync_runs} sync_runs, ` +
          `${deleted.instagram_webhook_deliveries} webhook deliveries` +
          (compacted.length ? `; compacted ${compacted.join(', ')}` : '') +
          `. Database ${databaseSize}; largest tables: ${top}`,
      );
    } catch (err) {
      this.logger.warn(
        `Retention finished but table sizes could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { dryRun, deleted, compacted, databaseSize };
  }

  private async count(table: string, where: string, ...params: unknown[]): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
      ...params,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** VACUUM can't run in a transaction; Prisma's raw execute runs it standalone. */
  private async vacuum(table: string, full: boolean): Promise<boolean> {
    try {
      await this.prisma.$executeRawUnsafe(`VACUUM ${full ? 'FULL ' : ''}${table}`);
      return true;
    } catch (err) {
      this.logger.warn(
        `VACUUM${full ? ' FULL' : ''} ${table} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
