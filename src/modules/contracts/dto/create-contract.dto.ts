import {
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ContractStatus } from '@prisma/client';

const INT_MAX = 2_147_483_647;

/**
 * Payload for `POST /contracts`, sent by the Outreach backend once a creator
 * signs. Every field is declared so the global forbidNonWhitelisted pipe accepts
 * it; the service upserts the creator by identity (email → instagram → name) and
 * records the contract. At least one identity key is required (enforced in the
 * service via CreatorsService).
 */
export class CreateContractDto {
  // --- Identity (creator dedup keys) --------------------------------------
  @IsOptional()
  @IsString()
  @MaxLength(200)
  creatorName?: string;

  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(/^@?[a-zA-Z0-9._]{1,30}$/, {
    message: 'instagramUsername must be a valid Instagram handle',
  })
  instagramUsername?: string;

  // --- Campaign + deliverables --------------------------------------------
  @IsOptional()
  @IsString()
  @MaxLength(200)
  brandName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  campaignName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  deliverables?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  numberOfDeliverables?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  timeline?: string;

  @IsOptional()
  @IsDateString({}, { message: 'deadline must be an ISO date string' })
  deadline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  usageRights?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  exclusivity?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  guaranteedViews?: number;

  // --- Commercial ----------------------------------------------------------
  @IsOptional()
  @IsNumber()
  @Min(0)
  compensation?: number;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code, e.g. USD' })
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  paymentTerms?: string;

  // --- Extra terms ---------------------------------------------------------
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  specialNotes?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  additionalTerms?: string[];

  // --- Contract ------------------------------------------------------------
  @IsString()
  @MaxLength(200)
  contractRef!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  contractUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  signerName?: string;

  @IsOptional()
  @IsDateString({}, { message: 'signedAt must be an ISO date string' })
  signedAt?: string;

  @IsOptional()
  @IsEnum(ContractStatus)
  status?: ContractStatus;
}
