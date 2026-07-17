import { Controller, Get, Param } from '@nestjs/common';
import { CreatorStatsService } from './creator-stats.service';

@Controller('creator-stats')
export class CreatorStatsController {
  constructor(private readonly creatorStats: CreatorStatsService) {}

  /** Per-campaign performance snapshots for a creator (newest sync first). */
  @Get('creator/:creatorId')
  findByCreator(@Param('creatorId') creatorId: string) {
    return this.creatorStats.findByCreator(creatorId);
  }
}
