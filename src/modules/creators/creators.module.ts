import { Module } from '@nestjs/common';
import { AdminWriteGuard } from '../../common/guards/admin-write.guard';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { AuthModule } from '../auth/auth.module';
import { CreatorMergeService } from './creator-merge.service';
import { CreatorsController } from './creators.controller';
import { CreatorsRepository } from './creators.repository';
import { CreatorsService } from './creators.service';

@Module({
  imports: [ActivityLogModule, AuthModule],
  controllers: [CreatorsController],
  providers: [CreatorsService, CreatorsRepository, CreatorMergeService, AdminWriteGuard],
  exports: [CreatorsService, CreatorsRepository, CreatorMergeService],
})
export class CreatorsModule {}
