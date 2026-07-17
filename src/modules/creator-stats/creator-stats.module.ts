import { Module } from '@nestjs/common';
import { CreatorStatsController } from './creator-stats.controller';
import { CreatorStatsService } from './creator-stats.service';

@Module({
  controllers: [CreatorStatsController],
  providers: [CreatorStatsService],
  exports: [CreatorStatsService],
})
export class CreatorStatsModule {}
