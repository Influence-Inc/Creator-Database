import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Editable mailing address (all fields optional; '' clears a field). */
export class EditAddressDto {
  @IsOptional() @IsString() @MaxLength(300) line1?: string;
  @IsOptional() @IsString() @MaxLength(300) line2?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) state?: string;
  @IsOptional() @IsString() @MaxLength(40) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(120) country?: string;
}

export class EditContactDto {
  // Transform '' → null BEFORE @IsEmail runs so an empty field can clear the
  // email. class-validator's @IsOptional skips validators on null/undefined
  // but NOT on '' — and the edit form ALWAYS emits the current value (empty
  // if the field is blank), so without this a blank email field 400s the
  // entire save with "email must be a valid email address". The service
  // treats null as "clear" (creatorData.email = contact.email || null).
  @Transform(({ value }) => (value === '' ? null : value))
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  email?: string | null;

  @IsOptional() @IsString() @MaxLength(60) phone?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => EditAddressDto)
  address?: EditAddressDto;
}

export class EditPaymentDto {
  @IsOptional() @IsString() @MaxLength(200) accountHolderName?: string;
  @IsOptional() @IsString() @MaxLength(200) bankName?: string;
  @IsOptional() @IsString() @MaxLength(64) accountNumber?: string;
  @IsOptional() @IsString() @MaxLength(64) iban?: string;
  @IsOptional() @IsString() @MaxLength(64) routingNumber?: string;
  @IsOptional() @IsString() @MaxLength(64) ifscCode?: string;
  @IsOptional() @IsString() @MaxLength(64) swiftCode?: string;
  @IsOptional() @IsString() @MaxLength(64) panNumber?: string;
  @IsOptional() @IsString() @MaxLength(64) taxIdNumber?: string;
}

/** Body for `PATCH /roster/:id/details`. */
export class UpdateDetailsDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => EditContactDto)
  contact?: EditContactDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => EditPaymentDto)
  payment?: EditPaymentDto;
}
