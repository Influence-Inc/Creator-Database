import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

/** Body for `POST /users` (admin creates a scouter account). */
export class CreateUserDto {
  @IsString()
  @MaxLength(40)
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  /** Instagram handle whose DMs should land on this scout's sheet. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  instagramHandle?: string;
}
