import { IsEmail, IsString, MinLength } from 'class-validator';

// Deliberately has no `role` field — public self-signup always creates a
// MEMBER account (see AuthController.signup). Full role selection is only
// available to already-authenticated admins via POST /users.
export class SignupDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}
