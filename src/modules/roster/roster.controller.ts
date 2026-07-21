import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { AdminWriteGuard } from '../../common/guards/admin-write.guard';
import { UpdateDetailsDto } from './dto/update-details.dto';
import { RosterService } from './roster.service';

/**
 * Endpoints backing the admin UI (served from /public).
 *
 *   GET   /roster              the creator roster (list screen)
 *   GET   /roster/:id          a creator's full profile (detail screen)
 *   GET   /roster/:id/contracts  full signed contracts (unredacted)
 *   PATCH /roster/:id/details  edit contact + payout details
 */
@Controller('roster')
export class RosterController {
  constructor(private readonly roster: RosterService) {}

  @Get()
  list() {
    return this.roster.roster();
  }

  @Get(':id')
  profile(@Param('id') id: string) {
    return this.roster.profile(id);
  }

  /**
   * Full signed contracts for a creator — unredacted payout details + signature
   * image, for payment processing and contract review. Same auth as every other
   * read (admin session or x-api-key via the global ReadAccessGuard).
   */
  @Get(':id/contracts')
  contracts(@Param('id') id: string) {
    return this.roster.contractsFull(id);
  }

  /**
   * Admin edit of a creator's contact + payout details. @Public bypasses the
   * global write guard; AdminWriteGuard then requires a valid admin session (the
   * dashboard) or the x-api-key.
   */
  @Public()
  @UseGuards(AdminWriteGuard)
  @Patch(':id/details')
  updateDetails(@Param('id') id: string, @Body() dto: UpdateDetailsDto) {
    return this.roster.updateDetails(id, dto);
  }
}
