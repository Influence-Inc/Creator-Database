import { Body, Controller, Get, Param, Patch, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { AdminWriteGuard } from '../../common/guards/admin-write.guard';
import { ContractDocumentService } from './contract-document.service';
import { UpdateDetailsDto } from './dto/update-details.dto';
import { RosterService } from './roster.service';

/**
 * Endpoints backing the admin UI (served from /public).
 *
 *   GET   /roster                                   the creator roster (list screen)
 *   GET   /roster/:id                               a creator's full profile (detail screen)
 *   GET   /roster/:id/contracts                     full signed contracts (unredacted)
 *   GET   /roster/:id/contracts/:contractId/document  legal contract document (HTML, no bank details)
 *   PATCH /roster/:id/details                       edit contact + payout details
 */
@Controller('roster')
export class RosterController {
  constructor(
    private readonly roster: RosterService,
    private readonly contractDocs: ContractDocumentService,
  ) {}

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
   * A single signed contract rendered as a compliant legal document (a Creator
   * Services Agreement) that the admin can view or save as PDF.
   *
   * The document EXCLUDES the creator's bank / payout details by design — those
   * are held separately. Same auth as every other read (admin session or
   * x-api-key via the global ReadAccessGuard). `?download=1` returns it as a
   * file attachment; `?print=1` renders it inline and auto-opens the browser's
   * print dialog so the admin can save it as a PDF.
   */
  @Get(':id/contracts/:contractId/document')
  async contractDocument(
    @Param('id') id: string,
    @Param('contractId') contractId: string,
    @Query('download') download: string | undefined,
    @Query('print') print: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const isSet = (v: string | undefined) => v !== undefined && v !== '0' && v !== 'false';
    const wantsPrint = isSet(print);
    const { filename, html } = await this.contractDocs.render(id, contractId, {
      print: wantsPrint,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (isSet(download)) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    return html;
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
