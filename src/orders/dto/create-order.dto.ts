import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsNumberString,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateOrderItemDto {
  @IsString()
  itemName: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @Min(1)
  quantity: number;

  @IsNumberString()
  unitPrice: string;

  @IsString()
  @IsOptional()
  unit?: string;
}

export class CreateOrderDto {
  @IsString()
  receiverId: string;

  @IsBoolean()
  @IsOptional()
  isCash?: boolean;

  @IsBoolean()
  @IsOptional()
  pricesVisible?: boolean;

  @IsNumberString()
  @IsOptional()
  tax?: string;

  @IsNumberString()
  @IsOptional()
  discount?: string;

  @IsNumberString()
  @IsOptional()
  paidAmount?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsString()
  @IsOptional()
  dueDate?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];

  @IsString()
  @IsOptional()
  clientId?: string; // Device-generated UUID — used for idempotency (offline sync dedup)
}
