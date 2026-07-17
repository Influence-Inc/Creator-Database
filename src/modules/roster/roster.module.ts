import { Module } from '@nestjs/common';
import { RosterController } from './roster.controller';
import { RosterService } from './roster.service';

@Module({
  controllers: [RosterController],
  providers: [RosterService],
})
export class RosterModule {}
