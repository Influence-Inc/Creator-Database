import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { AdminWriteGuard } from '../../common/guards/admin-write.guard';
import { CreatorsService } from './creators.service';
import { CategorizeCreatorsDto } from './dto/categorize-creators.dto';
import { CreateCreatorDto } from './dto/create-creator.dto';
import { ParticipationQueryDto } from './dto/participation-query.dto';
import { QueryCreatorsDto } from './dto/query-creators.dto';
import { UpdateCreatorDto } from './dto/update-creator.dto';

/**
 * Creator REST endpoints. Controllers stay thin — they validate/parse the
 * request (via DTOs + the global ValidationPipe) and delegate to the service.
 *
 *   GET   /creators              list (search / filter / sort / paginate)
 *   POST  /creators              manual create-or-merge
 *   POST  /creators/categorize   bulk classify a batch as used / unused / new
 *   GET   /creator/:id           fetch one
 *   PATCH /creator/:id           manual update
 *   GET   /creator/:id/activity  audit trail
 */
@Controller()
export class CreatorsController {
  constructor(private readonly creatorsService: CreatorsService) {}

  @Get('creators')
  findMany(@Query() query: QueryCreatorsDto) {
    return this.creatorsService.findMany(query);
  }

  @Post('creators')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateCreatorDto) {
    return this.creatorsService.createManual(dto);
  }

  /**
   * New-vs-old segmentation for the Outreach Deal Studio. Batch lookup by
   * Instagram handle: reports which creators have prior participation in a
   * campaign other than the current one. Read-only despite the POST verb (a
   * batch body is cleaner than a long query string); the x-api-key the Outreach
   * backend already sends satisfies the write guard.
   */
  @Post('creators/participation')
  @HttpCode(HttpStatus.OK)
  checkParticipation(@Body() dto: ParticipationQueryDto) {
    return this.creatorsService.checkParticipation(dto);
  }

  /**
   * Used / Unused / New classification for the Outreach Deal Studio badges.
   * A batch of {email?, instagramUsername?} keys returns each key's category —
   * 'used' (has ≥1 contract row), 'unused' (in DB, no contracts), 'new' (not
   * in DB) — plus the master record for used/unused so the dashboard can render
   * "N past contracts" tooltips without a second call. Same POST+API-key model
   * as /creators/participation above.
   */
  @Post('creators/categorize')
  @HttpCode(HttpStatus.OK)
  categorize(@Body() dto: CategorizeCreatorsDto) {
    return this.creatorsService.categorize(dto);
  }

  @Get('creator/:id')
  findOne(@Param('id') id: string) {
    return this.creatorsService.findOne(id);
  }

  @Patch('creator/:id')
  update(@Param('id') id: string, @Body() dto: UpdateCreatorDto) {
    return this.creatorsService.updateManual(id, dto);
  }

  @Get('creator/:id/activity')
  activity(@Param('id') id: string) {
    return this.creatorsService.getActivity(id);
  }

  /**
   * Delete a single creator (cascades to its stats + contracts). Called from
   * the admin dashboard, so @Public bypasses the global write guard (which only
   * accepts the x-api-key) and AdminWriteGuard then accepts EITHER the admin
   * session cookie OR the x-api-key — matching how /roster/:id/details works.
   */
  @Public()
  @UseGuards(AdminWriteGuard)
  @Delete('creator/:id')
  remove(@Param('id') id: string) {
    return this.creatorsService.remove(id);
  }
}
