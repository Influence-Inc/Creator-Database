import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ContractsService } from './contracts.service';
import { CreateContractDto } from './dto/create-contract.dto';

@Controller('contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  /** Ingest a signed contract from the Outreach backend (create-or-merge). */
  @Post()
  create(@Body() dto: CreateContractDto) {
    return this.contractsService.createFromOutreach(dto);
  }

  /** Contract history for a creator (newest first). */
  @Get('creator/:creatorId')
  findByCreator(@Param('creatorId') creatorId: string) {
    return this.contractsService.findByCreator(creatorId);
  }
}
