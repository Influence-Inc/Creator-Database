import { Module } from '@nestjs/common';
import { SessionGuard } from '../../common/guards/session.guard';
import { DealStudioModule } from '../../integrations/deal-studio/deal-studio.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [DealStudioModule],
  controllers: [UsersController],
  providers: [UsersService, SessionGuard],
  exports: [UsersService],
})
export class UsersModule {}
