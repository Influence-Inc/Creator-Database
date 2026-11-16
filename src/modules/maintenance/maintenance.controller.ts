import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { CreatorMergeService } from '../creators/creator-merge.service';
import { MergeCreatorsDto } from './dto/merge-creators.dto';
import { DuplicateCreatorsService } from './duplicate-creators.service';
import { MaintenanceService } from './maintenance.service';
import { RetentionService } from './retention.service';

/**
 * Guarded maintenance actions (mutations → require x-api-key via ApiKeyGuard).
 *
 *   POST /maintenance/purge-demo               delete demo/seed creators
 *   POST /maintenance/purge-demo?dryRun=true      preview what would be deleted
 *   GET  /maintenance/duplicate-creators       list split records + the evidence
 *   POST /maintenance/merge-duplicates?dryRun=true  fold every matched pair
 *   POST /maintenance/merge-creators           merge one specific pair by id
 *   GET  /maintenance/db-size                  database + per-table disk usage
 *   POST /maintenance/prune-logs?dryRun=true   preview / run log-table retention
 */
@Controller('maintenance')
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly duplicates: DuplicateCreatorsService,
    private readonly merger: CreatorMergeService,
    private readonly retention: RetentionService,
  ) {}

  /** Read-only: how big the database is and which tables are taking the space. */
  @Get('db-size')
  dbSize() {
    return this.retention.tableSizes();
  }

  /**
   * Prune the operational log tables (failed_jobs, sync_runs, webhook
   * deliveries) and collapse pre-fix sync churn in activity_logs now, instead
   * of waiting for the next boot / 6-hourly run. Defaults to a dry run; pass
   * dryRun=false to delete. Business data is never touched.
   */
  @Post('prune-logs')
  @HttpCode(HttpStatus.OK)
  pruneLogs(@Query('dryRun') dryRun?: string) {
    return this.retention.prune(!(dryRun === 'false' || dryRun === '0'));
  }

  @Post('purge-demo')
  @HttpCode(HttpStatus.OK)
  purgeDemo(@Query('dryRun') dryRun?: string) {
    return this.maintenance.purgeDemo(dryRun === 'true' || dryRun === '1');
  }

  /**
   * Read-only: which creators look split, what ties each pair together, and how
   * sure we are. `high` pairs carry hard identity evidence; `review` pairs rest
   * on the duplicate's name appearing inside the master's handle and need a
   * human before anything is merged.
   */
  @Get('duplicate-creators')
  findDuplicates() {
    return this.duplicates.find();
  }

  /**
   * Merge the `high`-confidence pairs. Defaults to a dry run. `review` pairs are
   * never touched here — confirm those individually via POST /merge-creators.
   */
  @Post('merge-duplicates')
  @HttpCode(HttpStatus.OK)
  mergeDuplicates(@Query('dryRun') dryRun?: string) {
    // Opt IN to writing: an unqualified call previews rather than mutates.
    return this.duplicates.mergeAll(!(dryRun === 'false' || dryRun === '0'));
  }

  /** Merge a specific pair — how a reviewed `review`-grade match gets applied. */
  @Post('merge-creators')
  @HttpCode(HttpStatus.OK)
  mergeCreators(@Body() dto: MergeCreatorsDto) {
    return this.merger.merge(dto.survivorId, dto.duplicateId, { dryRun: dto.dryRun === true });
  }
}
