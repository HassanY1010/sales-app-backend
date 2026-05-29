import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class VerifyResetPinDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  identifier: string;

  @IsString()
  @Matches(/^\S{4}$/)
  pin: string;
}
