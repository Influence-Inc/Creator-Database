import { Module } from '@nestjs/common';
import { SessionGuard } from '../../common/guards/session.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, SessionGuard],
  exports: [UsersService],
})
export class UsersModule {}
