import {
  IsEnum,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class CreateAdjustmentRequestDto {
  @IsEnum(['ORDER', 'TRANSACTION'])
  targetType: 'ORDER' | 'TRANSACTION';

  @IsString()
  targetId: string;

  @IsNumberString()
  @IsOptional()
  requestedAmount?: string;

  @IsString()
  @IsOptional()
  requestedDueDate?: string;

  @IsString()
  @IsOptional()
  @Length(1, 1000)
  requestedNote?: string;

  @IsString()
  @IsOptional()
  originalData?: string;

  @IsString()
  @IsOptional()
  requestedData?: string;

  @IsString()
  @Length(5, 1000)
  reason: string;
}
