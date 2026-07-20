import { Controller, Get, Param } from '@nestjs/common';
import { RosterService } from './roster.service';

/**
 * Read-only endpoints backing the admin UI (served from /public).
 *
 *   GET /roster        the creator roster (list screen)
 *   GET /roster/:id    a creator's full profile (detail screen)
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
}
