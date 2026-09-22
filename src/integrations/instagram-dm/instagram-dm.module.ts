import { Module } from '@nestjs/common';
import { SessionGuard } from '../../common/guards/session.guard';
import { InstagramDmController } from './instagram-dm.controller';
import { InstagramDmService } from './instagram-dm.service';
import { InstagramGraphService } from './instagram-graph.service';
import { InstagramInboxScheduler } from './instagram-inbox.scheduler';

@Module({
  controllers: [InstagramDmController],
  providers: [InstagramDmService, InstagramGraphService, InstagramInboxScheduler, SessionGuard],
  exports: [InstagramDmService],
})
export class InstagramDmModule {}
