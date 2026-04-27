import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateConnectionDto {
  @IsString()
  @IsNotEmpty()
  receiverId: string;

  @IsEnum(['CUSTOMER', 'SUPPLIER'])
  connectionType: 'CUSTOMER' | 'SUPPLIER';

  @IsNumber()
  @Min(0)
  @IsOptional()
  creditLimit?: number;

  @IsString()
  @IsOptional()
  billingCycle?: string; // WEEKLY, MONTHLY, CUSTOM

  @IsNumber()
  @IsOptional()
  openingBalance?: number; // رصيد افتتاحي
}
