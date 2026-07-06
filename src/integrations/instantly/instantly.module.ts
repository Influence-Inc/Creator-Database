import { Module } from '@nestjs/common';
import { InstantlyService } from './instantly.service';

@Module({
  providers: [InstantlyService],
  exports: [InstantlyService],
})
export class InstantlyModule {}
