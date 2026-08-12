import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { CreatorMergeService } from '../creators/creator-merge.service';
import { MergeCreatorsDto } from './dto/merge-creators.dto';
import { DuplicateCreatorsService } from './duplicate-creators.service';
import { MaintenanceService } from './maintenance.service';

/**
 * Guarded maintenance actions (mutations → require x-api-key via ApiKeyGuard).
 *
 *   POST /maintenance/purge-demo               delete demo/seed creators
 *   POST /maintenance/purge-demo?dryRun=true      preview what would be deleted
 *   GET  /maintenance/duplicate-creators       list split records + the evidence
 *   POST /maintenance/merge-duplicates?dryRun=true  fold every matched pair
 *   POST /maintenance/merge-creators           merge one specific pair by id
 */
@Controller('maintenance')
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly duplicates: DuplicateCreatorsService,
    private readonly merger: CreatorMergeService,
  ) {}

  @Post('purge-demo')
  @HttpCode(HttpStatus.OK)
  purgeDemo(@Query('dryRun') dryRun?: string) {
    return this.maintenance.purgeDemo(dryRun === 'true' || dryRun === '1');
  }

  /** Read-only: which creators look split, and what ties each pair together. */
  @Get('duplicate-creators')
  findDuplicates() {
    return this.duplicates.find();
  }

  /** Merge every confidently-matched pair. Defaults to a dry run. */
  @Post('merge-duplicates')
  @HttpCode(HttpStatus.OK)
  mergeDuplicates(@Query('dryRun') dryRun?: string) {
    // Opt IN to writing: an unqualified call previews rather than mutates.
    return this.duplicates.mergeAll(!(dryRun === 'false' || dryRun === '0'));
  }

  /** Merge a specific pair — for the ambiguous ones detection won't auto-pair. */
  @Post('merge-creators')
  @HttpCode(HttpStatus.OK)
  mergeCreators(@Body() dto: MergeCreatorsDto) {
    return this.merger.merge(dto.survivorId, dto.duplicateId, { dryRun: dto.dryRun === true });
  }
}
