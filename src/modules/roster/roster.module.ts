import { Module } from '@nestjs/common';
import { AdminWriteGuard } from '../../common/guards/admin-write.guard';
import { AuthModule } from '../auth/auth.module';
import { ContractDocumentService } from './contract-document.service';
import { RosterController } from './roster.controller';
import { RosterService } from './roster.service';

@Module({
  imports: [AuthModule],
  controllers: [RosterController],
  providers: [RosterService, ContractDocumentService, AdminWriteGuard],
})
export class RosterModule {}
