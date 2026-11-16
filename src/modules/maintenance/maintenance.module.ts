import { Module } from '@nestjs/common';
import { CreatorsModule } from '../creators/creators.module';
import { DuplicateCreatorsService } from './duplicate-creators.service';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';
import { RetentionService } from './retention.service';

@Module({
  imports: [CreatorsModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService, DuplicateCreatorsService, RetentionService],
})
export class MaintenanceModule {}
