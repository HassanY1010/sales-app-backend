import { IsEnum, IsNotEmpty, IsNumberString, IsOptional, IsString } from 'class-validator';

export class CreateTransactionDto {
  @IsEnum(['PAYMENT', 'SALE', 'PURCHASE', 'ADJUSTMENT'])
  transactionType: 'PAYMENT' | 'SALE' | 'PURCHASE' | 'ADJUSTMENT';

  @IsNumberString()
  amount: string;

  @IsString()
  @IsNotEmpty()
  receiverId: string;

  @IsString()
  @IsOptional()
  orderId?: string;

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
}
