import { Module } from '@nestjs/common';
import { SessionGuard } from '../../common/guards/session.guard';
import { DealStudioController } from './deal-studio.controller';
import { DealStudioService } from './deal-studio.service';

@Module({
  controllers: [DealStudioController],
  providers: [DealStudioService, SessionGuard],
  exports: [DealStudioService],
})
export class DealStudioModule {}
