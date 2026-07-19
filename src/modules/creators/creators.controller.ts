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
} from '@nestjs/common';
import { CreatorsService } from './creators.service';
import { CreateCreatorDto } from './dto/create-creator.dto';
import { ParticipationQueryDto } from './dto/participation-query.dto';
import { QueryCreatorsDto } from './dto/query-creators.dto';
import { UpdateCreatorDto } from './dto/update-creator.dto';

/**
 * Creator REST endpoints. Controllers stay thin — they validate/parse the
 * request (via DTOs + the global ValidationPipe) and delegate to the service.
 *
 *   GET   /creators            list (search / filter / sort / paginate)
 *   POST  /creators            manual create-or-merge
 *   GET   /creator/:id         fetch one
 *   PATCH /creator/:id         manual update
 *   GET   /creator/:id/activity   audit trail
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

  /** Delete a single creator (cascades to its stats + contracts). */
  @Delete('creator/:id')
  remove(@Param('id') id: string) {
    return this.creatorsService.remove(id);
  }
}
