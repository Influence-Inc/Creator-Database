import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { CreatorMergeService } from './creator-merge.service';
import { CreatorsController } from './creators.controller';
import { CreatorsRepository } from './creators.repository';
import { CreatorsService } from './creators.service';

@Module({
  imports: [ActivityLogModule],
  controllers: [CreatorsController],
  providers: [CreatorsService, CreatorsRepository, CreatorMergeService],
  exports: [CreatorsService, CreatorsRepository, CreatorMergeService],
})
export class CreatorsModule {}
