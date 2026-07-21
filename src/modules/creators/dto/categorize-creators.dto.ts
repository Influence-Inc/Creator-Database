import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * A single identity to classify. Either field may be present — at least one is
 * required (the service ignores empty rows). Values are normalized on the way
 * in (lower-cased, `@` stripped, IG URLs collapsed to a handle) so callers
 * don't have to.
 */
export class CategorizeKeyDto {
  @IsOptional()
  @IsString()
  @MaxLength(320)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  instagramUsername?: string;
}

/**
 * Payload for POST /creators/categorize. A batch of {email?, instagramUsername?}
 * keys — the response returns the same-length array with each key's
 * classification: 'used' (in-DB, ≥1 contract), 'unused' (in-DB, no contracts),
 * or 'new' (not in DB). Cap the batch size so a stray page load with 500 rows
 * doesn't accidentally scan the whole creators table.
 */
export class CategorizeCreatorsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CategorizeKeyDto)
  keys!: CategorizeKeyDto[];
}
