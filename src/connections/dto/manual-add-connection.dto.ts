import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class ManualAddConnectionDto {
  @IsString()
  @Length(2, 120)
  name: string;

  @IsString()
  @Length(6, 30)
  phoneNumber: string;

  @IsString()
  @Length(2, 160)
  @IsOptional()
  businessName?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsEnum(['CUSTOMER', 'SUPPLIER'])
  @IsOptional()
  connectionType?: 'CUSTOMER' | 'SUPPLIER';

  @IsNumber()
  @IsOptional()
  openingBalance?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  creditLimit?: number;

  @IsString()
  @IsOptional()
  billingCycle?: string;

  @IsString()
  @IsOptional()
  dueDate?: string;

  @IsBoolean()
  @IsOptional()
  showPrices?: boolean;

  @IsEnum(['CUSTOMERS', 'SUPPLIERS'])
  @IsOptional()
  requestSource?: 'CUSTOMERS' | 'SUPPLIERS';
}
