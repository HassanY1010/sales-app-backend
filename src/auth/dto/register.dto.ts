import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsString()
  @IsNotEmpty()
  fullName: string;

  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsString()
  @IsOptional()
  @MinLength(4)
  securityPin?: string;

  @IsString()
  @IsEnum(['individual', 'business'])
  userType: 'individual' | 'business';

  // Fields if userType is 'business'
  @ValidateIf((o) => o.userType === 'business')
  @IsString()
  @IsNotEmpty()
  businessName?: string;

  @ValidateIf((o) => o.userType === 'business')
  @IsString()
  @IsOptional()
  businessType?: string;
}
