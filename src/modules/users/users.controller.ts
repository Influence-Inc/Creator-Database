import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SessionGuard } from '../../common/guards/session.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

/**
 * Scouter account management, admin-only.
 *
 *   GET    /users         list accounts (optionally ?role=SCOUT)
 *   POST   /users         create a scouter
 *   PATCH  /users/:id     rename / activate / reset password
 *   DELETE /users/:id     remove the account and their rows
 *
 * `@Public()` takes these off the global API-key/read guards so SessionGuard is
 * the single authority; `@Roles(ADMIN)` is what actually keeps scouts out.
 */
@Public()
@UseGuards(SessionGuard)
@Roles(UserRole.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query('role') role?: UserRole) {
    return this.users.list(role === UserRole.ADMIN || role === UserRole.SCOUT ? role : undefined);
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.users.remove(id);
  }
}
