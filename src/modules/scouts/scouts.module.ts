import { Module } from '@nestjs/common';
import { SessionGuard } from '../../common/guards/session.guard';
import { CreatorsModule } from '../creators/creators.module';
import { ScoutsController } from './scouts.controller';
import { ScoutsService } from './scouts.service';

@Module({
  imports: [CreatorsModule],
  controllers: [ScoutsController],
  providers: [ScoutsService, SessionGuard],
  exports: [ScoutsService],
})
export class ScoutsModule {}
