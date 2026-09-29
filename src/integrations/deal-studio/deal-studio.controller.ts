import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SessionGuard } from '../../common/guards/session.guard';
import { DealStudioService } from './deal-studio.service';

/**
 * Deal Studio, as seen from the admin console.
 *
 *   GET /deal-studio/campaigns   campaigns a scout can be assigned to
 *
 * Proxied rather than called from the browser so the bot token never leaves
 * the server. `@Public()` hands auth to SessionGuard; `@Roles(ADMIN)` keeps
 * scouts out.
 */
@Public()
@UseGuards(SessionGuard)
@Roles(UserRole.ADMIN)
@Controller('deal-studio')
export class DealStudioController {
  constructor(private readonly dealStudio: DealStudioService) {}

  /**
   * Never throws: the picker needs to say *why* it's empty — not connected, or
   * connected but unreachable — and an error status would only say "failed".
   */
  @Get('campaigns')
  async campaigns() {
    if (!this.dealStudio.isConfigured()) {
      return { configured: false, campaigns: [] };
    }
    try {
      return { configured: true, campaigns: await this.dealStudio.listCampaigns() };
    } catch (err) {
      return {
        configured: true,
        campaigns: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
