import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ContractStatus } from '@prisma/client';

const INT_MAX = 2_147_483_647;

/** Signer's mailing address, captured on the signing form. */
export class ContractAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  line1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  line2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  zip?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  country?: string;
}

/**
 * Payout/bank details captured on the signing form. Country-specific fields are
 * all optional; the Creator-DB stores whatever the creator supplied as JSON.
 * Sensitive — accepted only over the x-api-key-guarded write path.
 */
export class ContractPaymentDetailsDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  accountHolderName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  accountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  routingNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ifscCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  panNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  swiftCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxIdNumber?: string;
}

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

  // --- Signer details (captured on the signing form) ----------------------
  @IsOptional()
  @IsEmail({}, { message: 'signerEmail must be a valid email address' })
  signerEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  signerPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  signerGender?: string;

  @IsOptional()
  @IsDateString({}, { message: 'signerSignedDate must be an ISO date string' })
  signerSignedDate?: string;

  /** Drawn signature as a base64 data URL — large, so no MaxLength cap. */
  @IsOptional()
  @IsString()
  @Matches(/^data:image\/(png|jpeg|jpg|svg\+xml);base64,/, {
    message: 'signatureImage must be a base64 image data URL',
  })
  signatureImage?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ContractAddressDto)
  address?: ContractAddressDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ContractPaymentDetailsDto)
  paymentDetails?: ContractPaymentDetailsDto;
}
