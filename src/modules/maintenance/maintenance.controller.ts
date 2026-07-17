import { Controller, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';

/**
 * Guarded maintenance actions (mutations → require x-api-key via ApiKeyGuard).
 *
 *   POST /maintenance/purge-demo            delete demo/seed creators
 *   POST /maintenance/purge-demo?dryRun=true   preview what would be deleted
 */
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Post('purge-demo')
  @HttpCode(HttpStatus.OK)
  purgeDemo(@Query('dryRun') dryRun?: string) {
    return this.maintenance.purgeDemo(dryRun === 'true' || dryRun === '1');
  }
}
