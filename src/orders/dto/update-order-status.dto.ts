import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumberString,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class UpdateOrderStatusDto {
  @IsEnum([
    'PENDING',
    'ACCEPTED',
    'REJECTED',
    'COMPLETED',
    'CANCELLED',
    'SUBMITTED',
    'RECEIVED',
    'UNDER_REVIEW',
    'PRICED',
    'RESUBMITTED',
  ])
  status:
    | 'PENDING'
    | 'ACCEPTED'
    | 'REJECTED'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'SUBMITTED'
    | 'RECEIVED'
    | 'UNDER_REVIEW'
    | 'PRICED'
    | 'RESUBMITTED';

  @IsOptional()
  @IsString()
  rejectionReason?: string;
}

export class UpdateOrderPriceItemDto {
  @IsString()
  id: string;

  @IsNumberString()
  unitPrice: string;

  @IsOptional()
  @IsString()
  itemName?: string;

  @IsOptional()
  quantity?: number;

  @IsOptional()
  @IsString()
  unit?: string;
}

export class UpdateOrderPricesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateOrderPriceItemDto)
  items: UpdateOrderPriceItemDto[];

  @IsNumberString()
  @IsOptional()
  tax?: string;

  @IsNumberString()
  @IsOptional()
  discount?: string;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsString()
  @IsOptional()
  dueDate?: string;

  @IsNumberString()
  @IsOptional()
  paidAmount?: string;
}
