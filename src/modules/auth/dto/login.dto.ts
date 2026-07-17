import { IsString, MaxLength } from 'class-validator';

/** Body for `POST /auth/login`. */
export class LoginDto {
  @IsString()
  @MaxLength(200)
  username!: string;

  @IsString()
  @MaxLength(200)
  password!: string;
}
