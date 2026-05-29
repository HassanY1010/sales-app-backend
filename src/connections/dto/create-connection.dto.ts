import { IsEnum, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateConnectionDto {
  @IsUUID()
  receiverId: string;

  @IsEnum(['CUSTOMER', 'SUPPLIER'])
  connectionType: 'CUSTOMER' | 'SUPPLIER';

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

  @IsNumber()
  @IsOptional()
  openingBalance?: number;

  @IsOptional()
  showPrices?: boolean;
}

export class AcceptConnectionDto {
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

  @IsNumber()
  @IsOptional()
  openingBalance?: number;

  @IsOptional()
  showPrices?: boolean;
}
