import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SendDirectNotificationDto {
  @IsOptional()
  @IsString()
  targetBusinessId?: string;

  @IsOptional()
  @IsString()
  targetUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  body: string;
}
