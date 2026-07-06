import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { CreatorsController } from './creators.controller';
import { CreatorsRepository } from './creators.repository';
import { CreatorsService } from './creators.service';

@Module({
  imports: [ActivityLogModule],
  controllers: [CreatorsController],
  providers: [CreatorsService, CreatorsRepository],
  exports: [CreatorsService, CreatorsRepository],
})
export class CreatorsModule {}
