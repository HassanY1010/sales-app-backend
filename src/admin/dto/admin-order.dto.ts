import {
  IsOptional,
  IsString,
  IsBoolean,
  IsEnum,
  IsDateString,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class AdminOrdersQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(['PENDING', 'ACCEPTED', 'REJECTED', 'COMPLETED', 'CANCELLED'])
  status?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isCash?: boolean;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  minAmount?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  maxAmount?: number;

  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt';

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}

export class UpdateOrderStatusDto {
  @IsString()
  orderId: string;

  @IsEnum(['PENDING', 'ACCEPTED', 'REJECTED', 'COMPLETED', 'CANCELLED'])
  status: string;
}
