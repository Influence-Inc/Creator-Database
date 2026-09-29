import { Module } from '@nestjs/common';
import { SessionGuard } from '../../common/guards/session.guard';
import { DealStudioModule } from '../../integrations/deal-studio/deal-studio.module';
import { InstagramDmModule } from '../../integrations/instagram-dm/instagram-dm.module';
import { CreatorsModule } from '../creators/creators.module';
import { UsersModule } from '../users/users.module';
import { ScoutsController } from './scouts.controller';
import { ScoutsService } from './scouts.service';

@Module({
  imports: [CreatorsModule, UsersModule, InstagramDmModule, DealStudioModule],
  controllers: [ScoutsController],
  providers: [ScoutsService, SessionGuard],
  exports: [ScoutsService],
})
export class ScoutsModule {}
