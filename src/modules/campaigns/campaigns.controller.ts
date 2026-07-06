import { Controller, Get, Param, Query } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { QueryCampaignsDto } from './dto/query-campaigns.dto';

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Get()
  findMany(@Query() query: QueryCampaignsDto) {
    return this.campaignsService.findMany(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.campaignsService.findOne(id);
  }
}
