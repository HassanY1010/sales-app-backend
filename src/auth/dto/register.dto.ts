import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;

  @IsString()
  @IsOptional()
  @MinLength(6)
  @MaxLength(128)
  confirmPassword?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\S{4}$/)
  securityPin: string;

  @IsString()
  @IsEnum(['individual', 'business'])
  userType: 'individual' | 'business';

  // Fields if userType is 'business'
  @ValidateIf((o) => o.userType === 'business')
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  businessName?: string;

  @ValidateIf((o) => o.userType === 'business')
  @IsString()
  @IsOptional()
  @MaxLength(80)
  businessType?: string;

  @IsString()
  @IsOptional()
  referredByCode?: string;
}
