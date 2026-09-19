import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for `PATCH /users/:id` — rename, activate/deactivate, reset password. */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password?: string;

  /** Empty string clears the Instagram link. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  instagramHandle?: string;
}
