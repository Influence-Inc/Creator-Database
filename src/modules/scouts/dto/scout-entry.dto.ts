import { QualificationStatus, ScoutGender } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/** Fields a scout fills in on their sheet. */
export class CreateScoutEntryDto {
  @IsString()
  @MaxLength(500)
  instagramProfileLink!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reelIdeas?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  approxAge?: number;

  @IsOptional()
  @IsEnum(ScoutGender)
  gender?: ScoutGender;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  language?: string;

  /** Admins may add a row on a specific scout's sheet; ignored for scouts. */
  @IsOptional()
  @IsUUID()
  scoutId?: string;
}

/** Same fields, all optional — a scout editing one cell at a time. */
export class UpdateScoutEntryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instagramProfileLink?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reelIdeas?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  approxAge?: number;

  @IsOptional()
  @IsEnum(ScoutGender)
  gender?: ScoutGender;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  language?: string;
}

/** Admin-only verdict on a row. */
export class ReviewScoutEntryDto {
  @IsOptional()
  @IsEnum(QualificationStatus)
  qualification?: QualificationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

/** Body for `PATCH /scouts/me/instagram`. An empty string clears the link. */
export class SetInstagramDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  instagramHandle?: string;
}
