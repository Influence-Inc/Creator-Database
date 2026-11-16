import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';

/** First pass runs this long after boot, once the background migration is done. */
const FIRST_RUN_DELAY_MS = 90_000;
/** Then every six hours. */
const RUN_EVERY_MS = 6 * 3600 * 1000;

/**
 * Sync-written fields that flip-flopped before the outreach and stats syncs
 * folded each creator's campaigns into one upsert (see collapseByCreator).
 */
export const CHURN_SOURCES = ['INSTANTLY_DASHBOARD', 'STATS_SYNC'] as const;
export const CHURN_FIELDS = [
  'campaignName',
  'campaignId',
  'latestEmailDate',
  'creatorName',
  'outreachStage',
  'averageViews',
  'averageLikes',
  'cpm',
  'engagementRate',
  'riskLevel',
] as const;
/**
 * Only rows written before this are collapsed, so history the fixed syncs
 * write afterwards is never touched — even if the app restarts later.
 */
export const CHURN_CUTOFF = new Date('2026-11-20T00:00:00Z');

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
 * Plus, once per boot, a collapse of sync churn in activity_logs: before the
 * syncs folded a creator's campaigns into one upsert, the Instantly and stats
 * syncs rewrote campaignName, campaignId, averageViews, … back and forth
 * several times per run and logged every flip — ~15M rows, 4.4 GB, which is
 * what actually filled the volume. For CHURN_FIELDS written by CHURN_SOURCES
 * before CHURN_CUTOFF, only the newest row per (creator, source, field) is
 * kept. Manual edits, Claude extractions, contract and scout history, and
 * everything after the cutoff are never touched. Runs per creator so each
 * statement stays small and the pass can be interrupted and resumed safely.
 *
 * Business data (creators, contracts, stats, email history, scout sheets,
 * Instagram messages) is never touched.
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

    const first = setTimeout(() => void this.runQuietly(true), FIRST_RUN_DELAY_MS);
    first.unref?.();
    this.schedulerRegistry.addTimeout('retention-first-run', first);

    const every = setInterval(() => void this.runQuietly(false), RUN_EVERY_MS);
    every.unref?.();
    this.schedulerRegistry.addInterval('retention', every);
  }

  private failedJobDays(): number {
    return Math.max(1, this.config.get<number>('jobs.retentionFailedJobDays') ?? 14);
  }

  private logDays(): number {
    return Math.max(1, this.config.get<number>('jobs.retentionLogDays') ?? 30);
  }

  private async runQuietly(collapseChurn: boolean): Promise<void> {
    try {
      await this.prune(false, { collapseChurn });
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

  async prune(
    dryRun = false,
    opts: { collapseChurn?: boolean } = { collapseChurn: true },
  ): Promise<PruneResult> {
    if (this.running) {
      return { dryRun, deleted: {}, compacted: [] };
    }
    this.running = true;
    try {
      return await this.doPrune(dryRun, opts.collapseChurn ?? true);
    } finally {
      this.running = false;
    }
  }

  private async doPrune(dryRun: boolean, collapseChurn: boolean): Promise<PruneResult> {
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
      if (collapseChurn) deleted.activity_logs = await this.collapseChurn(true);
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

    if (collapseChurn) {
      const activityBefore = await this.estimatedRows('activity_logs');
      deleted.activity_logs = await this.collapseChurn(false);
      if (deleted.activity_logs > 0 && deleted.activity_logs >= activityBefore / 2) {
        // Rewrites only the rows that remain, so it needs little free space.
        this.logger.log('Compacting activity_logs (VACUUM FULL) to return its space to the volume');
        if (await this.vacuum('activity_logs', true)) compacted.push('activity_logs');
      } else if (deleted.activity_logs > 0) {
        await this.vacuum('activity_logs', false);
      }
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
          (deleted.activity_logs !== undefined
            ? `, ${deleted.activity_logs} sync-churn activity_logs`
            : '') +
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

  /**
   * Keep only the newest pre-cutoff row per (creator, source, field) for the
   * churned sync fields. One creator per statement: bounded WAL and lock time,
   * and an interrupted pass just carries on next boot.
   */
  private async collapseChurn(dryRun: boolean): Promise<number> {
    const sources = CHURN_SOURCES.map((v) => `'${v}'`).join(', ');
    const fields = CHURN_FIELDS.map((v) => `'${v}'`).join(', ');
    const keepers = `
      SELECT source, "changedField", max("createdAt") AS keep_at
        FROM activity_logs
       WHERE "creatorId" = $1 AND "createdAt" < $2
         AND source::text IN (${sources}) AND "changedField" IN (${fields})
       GROUP BY 1, 2`;
    const match = `a."creatorId" = $1 AND a.source = k.source
         AND a."changedField" = k."changedField" AND a."createdAt" < k.keep_at`;

    const creators = await this.prisma.creator.findMany({ select: { id: true } });
    let total = 0;
    for (const [i, { id }] of creators.entries()) {
      if (dryRun) {
        const rows = await this.prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
          `SELECT count(*) AS n FROM activity_logs a JOIN (${keepers}) k ON ${match}`,
          id,
          CHURN_CUTOFF,
        );
        total += Number(rows[0]?.n ?? 0);
      } else {
        total += await this.prisma.$executeRawUnsafe(
          `DELETE FROM activity_logs a USING (${keepers}) k WHERE ${match}`,
          id,
          CHURN_CUTOFF,
        );
      }
      if (!dryRun && (i + 1) % 200 === 0) {
        this.logger.log(
          `Collapsing activity_logs sync churn: ${i + 1}/${creators.length} creators, ${total} rows removed`,
        );
      }
    }
    return total;
  }

  private async estimatedRows(table: string): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      'SELECT GREATEST(reltuples, 0)::float8 AS n FROM pg_class WHERE relname = $1',
      table,
    );
    return Number(rows[0]?.n ?? 0);
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
