import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { QualificationStatus, UserRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthedRequest, SessionGuard } from '../../common/guards/session.guard';
import { AuthPrincipal } from '../auth/auth.service';
import {
  CreateScoutEntryDto,
  ReviewScoutEntryDto,
  UpdateScoutEntryDto,
} from './dto/scout-entry.dto';
import { ScoutsService } from './scouts.service';

/**
 * The scouting sheet API.
 *
 *   GET    /scouts/entries        rows (a scout's own; everything for an admin)
 *   POST   /scouts/entries        add a row
 *   PATCH  /scouts/entries/:id    edit the scout-editable fields
 *   DELETE /scouts/entries/:id    remove a row
 *   PATCH  /scouts/entries/:id/review   admin: qualification + notes
 *   POST   /scouts/entries/:id/promote  admin: push into the Creator Database
 *   GET    /scouts/summary        admin: counters
 *
 * Routes are `@Public()` so the global API-key/read guards step aside and
 * SessionGuard is the single authority; `@Roles` then decides who gets in.
 * Ownership scoping lives in the service, which always narrows a scout to their
 * own rows regardless of what the request asks for.
 */
@Public()
@UseGuards(SessionGuard)
@Controller('scouts')
export class ScoutsController {
  constructor(private readonly scouts: ScoutsService) {}

  private principal(req: AuthedRequest): AuthPrincipal {
    // SessionGuard always sets this before the handler runs.
    return req.principal as AuthPrincipal;
  }

  @Get('entries')
  @Roles(UserRole.SCOUT, UserRole.ADMIN)
  list(
    @Req() req: AuthedRequest,
    @Query('scoutId') scoutId?: string,
    @Query('qualification') qualification?: QualificationStatus,
    @Query('search') search?: string,
  ) {
    return this.scouts.list(this.principal(req), { scoutId, qualification, search });
  }

  @Post('entries')
  @Roles(UserRole.SCOUT, UserRole.ADMIN)
  create(@Req() req: AuthedRequest, @Body() dto: CreateScoutEntryDto) {
    return this.scouts.create(this.principal(req), dto);
  }

  @Patch('entries/:id')
  @Roles(UserRole.SCOUT, UserRole.ADMIN)
  update(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: UpdateScoutEntryDto) {
    return this.scouts.update(id, this.principal(req), dto);
  }

  @Delete('entries/:id')
  @Roles(UserRole.SCOUT, UserRole.ADMIN)
  remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.scouts.remove(id, this.principal(req));
  }

  /** Admin-only: the qualification tick/cross and notes a scout can't edit. */
  @Patch('entries/:id/review')
  @Roles(UserRole.ADMIN)
  review(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: ReviewScoutEntryDto) {
    return this.scouts.review(id, this.principal(req), dto);
  }

  @Post('entries/:id/promote')
  @Roles(UserRole.ADMIN)
  promote(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.scouts.promote(id, this.principal(req));
  }

  @Get('summary')
  @Roles(UserRole.ADMIN)
  summary() {
    return this.scouts.summary();
  }
}
