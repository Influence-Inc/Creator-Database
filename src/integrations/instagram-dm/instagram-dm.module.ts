import { Module } from '@nestjs/common';
import { SessionGuard } from '../../common/guards/session.guard';
import { InstagramDmController } from './instagram-dm.controller';
import { InstagramDmService } from './instagram-dm.service';
import { InstagramGraphService } from './instagram-graph.service';

@Module({
  controllers: [InstagramDmController],
  providers: [InstagramDmService, InstagramGraphService, SessionGuard],
  exports: [InstagramDmService],
})
export class InstagramDmModule {}
