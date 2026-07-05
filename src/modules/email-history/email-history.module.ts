import { Module } from '@nestjs/common';
import { EmailHistoryService } from './email-history.service';

@Module({
  providers: [EmailHistoryService],
  exports: [EmailHistoryService],
})
export class EmailHistoryModule {}
