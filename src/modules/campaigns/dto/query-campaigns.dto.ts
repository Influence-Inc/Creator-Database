import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

const CAMPAIGN_SORT_FIELDS = ['name', 'brandName', 'createdAt', 'updatedAt', 'syncedAt'] as const;
export type CampaignSortField = (typeof CAMPAIGN_SORT_FIELDS)[number];
export { CAMPAIGN_SORT_FIELDS };

export class QueryCampaignsDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @IsOptional()
  @IsIn(CAMPAIGN_SORT_FIELDS as unknown as string[])
  sortBy: CampaignSortField = 'name';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'asc';
}
