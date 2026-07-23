import {
  IsEnum,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
} from 'class-validator';

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

  @IsEnum(['RECEIVED', 'PAID'])
  @IsOptional()
  paymentDirection?: 'RECEIVED' | 'PAID';

  @IsEnum(['CASH', 'TRANSFER', 'CHECK', 'OTHER'])
  @IsOptional()
  paymentMethod?: 'CASH' | 'TRANSFER' | 'CHECK' | 'OTHER';

  @IsString()
  @IsOptional()
  transferNumber?: string;

  @IsString()
  @IsOptional()
  connectionId?: string;

  @IsString()
  @IsOptional()
  sourceScreen?: string;

  @IsString()
  @IsOptional()
  clientId?: string; // Device-generated UUID — used for idempotency (offline sync dedup)
}
