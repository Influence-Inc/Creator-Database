import { Module } from '@nestjs/common';
import { AdminWriteGuard } from '../../common/guards/admin-write.guard';
import { AuthModule } from '../auth/auth.module';
import { RosterController } from './roster.controller';
import { RosterService } from './roster.service';

@Module({
  imports: [AuthModule],
  controllers: [RosterController],
  providers: [RosterService, AdminWriteGuard],
})
export class RosterModule {}
