import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { NegotiationStatus } from '@prisma/client';

const INT_MAX = 2_147_483_647;

/**
 * Payload for the manual creator API (`POST /creators`). All fields are
 * optional so partial records can be created; the service enforces that at
 * least one identity key (email / instagram / name) is present.
 */
export class CreateCreatorDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  creatorName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^@?[a-zA-Z0-9._]{1,30}$/, {
    message: 'instagramUsername must be a valid Instagram handle',
  })
  instagramUsername?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  instagramProfileLink?: string;

  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  campaignName?: string;

  @IsOptional()
  @IsString()
  campaignId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  outreachStage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  assignedManager?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  averageViews?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  averageLikes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  engagementRate?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  followers?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cpm?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  acceptedRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quotedRate?: number;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code, e.g. USD' })
  currency?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  numberOfVideos?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  numberOfStories?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  numberOfReels?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  guaranteedViews?: number;

  @IsOptional()
  @IsDateString({}, { message: 'deadline must be an ISO date string' })
  deadline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  deliverablesDescription?: string;

  @IsOptional()
  @IsDateString()
  latestEmailDate?: string;

  @IsOptional()
  @IsDateString()
  lastReplyDate?: string;

  @IsOptional()
  @IsString()
  threadId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  emailStatus?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  inboxRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  spamRate?: number;

  @IsOptional()
  @IsBoolean()
  bounced?: boolean;

  @IsOptional()
  @IsBoolean()
  opened?: boolean;

  @IsOptional()
  @IsBoolean()
  replied?: boolean;

  @IsOptional()
  @IsEnum(NegotiationStatus)
  status?: NegotiationStatus;
}
