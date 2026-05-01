import { IsString, MinLength, IsNotEmpty, IsOptional } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  email: string; // This can be email or phoneNumber

  @IsString()
  @MinLength(6)
  password: string;

  @IsString()
  @IsOptional()
  userType?: string; // individual or business
}
