import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  identifier: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  newPassword: string;

  @IsString()
  @Matches(/^\S{4}$/)
  pin: string;
}
