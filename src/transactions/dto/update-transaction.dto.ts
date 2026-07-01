import { IsEnum, IsNumberString, IsOptional, IsString } from 'class-validator';

export class UpdateTransactionDto {
  @IsNumberString()
  @IsOptional()
  amount?: string;

  @IsString()
  @IsOptional()
  note?: string;

  @IsString()
  @IsOptional()
  voucherNumber?: string;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsString()
  @IsOptional()
  dueDate?: string;

  @IsString()
  @IsOptional()
  attachmentUrl?: string;

  @IsEnum(['CASH', 'TRANSFER', 'CHECK', 'OTHER'])
  @IsOptional()
  paymentMethod?: 'CASH' | 'TRANSFER' | 'CHECK' | 'OTHER';

  @IsString()
  @IsOptional()
  transferNumber?: string;
}
