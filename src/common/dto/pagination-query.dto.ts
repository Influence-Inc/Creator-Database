import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Base pagination query. Domain query DTOs extend this to add search/filter/
 * sort fields. `page` is 1-indexed; `limit` is capped to protect the DB.
 */
export class PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => Number.parseInt(value, 10))
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => Number.parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  /** Offset derived from page/limit for Prisma's `skip`. */
  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}
