import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { NegotiationStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/** Category filter for the creator search. Mirrors the Deal Studio badges:
 *  used = ≥1 contract, unused = 0 contracts, any = don't filter. */
export const CREATOR_CATEGORIES = ['used', 'unused', 'any'] as const;
export type CreatorCategory = (typeof CREATOR_CATEGORIES)[number];

/** Columns a client is allowed to sort by (whitelist prevents injection). */
export const SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'creatorName',
  'acceptedRate',
  'quotedRate',
  'cpm',
  'averageViews',
  'followers',
  'deadline',
  'status',
  'latestEmailDate',
  'lastReplyDate',
] as const;

export type SortableField = (typeof SORTABLE_FIELDS)[number];

/**
 * Query parameters for `GET /creators`: free-text search, structured filters,
 * sorting, and pagination (inherited).
 */
export class QueryCreatorsDto extends PaginationQueryDto {
  /** Free-text search across name, instagram, email, campaign and manager. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @IsOptional()
  @IsEnum(NegotiationStatus)
  status?: NegotiationStatus;

  @IsOptional()
  @IsString()
  campaignId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  campaignName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  manager?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  instagram?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  email?: string;

  /** Restrict the results by Used/Unused (contract-count) category. Used by the
   *  Deal Studio search-and-add flow to pick from Creator-DB creators we've
   *  worked with before. Defaults to "any" (no category filter). */
  @IsOptional()
  @IsIn(CREATOR_CATEGORIES as unknown as string[])
  category: CreatorCategory = 'any';

  @IsOptional()
  @IsIn(SORTABLE_FIELDS as unknown as string[])
  sortBy: SortableField = 'updatedAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';
}
