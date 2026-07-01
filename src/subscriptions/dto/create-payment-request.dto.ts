import {
  IsString,
  IsNumber,
  IsOptional,
  IsPositive,
  Min,
} from 'class-validator';

export class CreatePaymentRequestDto {
  @IsString()
  wallet: string;

  @IsNumber()
  @IsPositive()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
