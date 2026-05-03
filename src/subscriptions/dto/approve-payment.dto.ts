import { IsUUID, IsOptional } from 'class-validator';

export class ApprovePaymentDto {
  @IsUUID()
  requestId: string;

  @IsOptional()
  notes?: string;
}