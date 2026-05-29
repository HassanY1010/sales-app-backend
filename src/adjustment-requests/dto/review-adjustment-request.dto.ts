import { IsString, Length } from 'class-validator';

export class RejectAdjustmentRequestDto {
  @IsString()
  @Length(5, 1000)
  rejectionReason: string;
}
