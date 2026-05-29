import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SendDebtorAlertsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  connectionIds: string[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  body: string;
}
