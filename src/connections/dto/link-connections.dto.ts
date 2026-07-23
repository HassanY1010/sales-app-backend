import { IsNotEmpty, IsString } from 'class-validator';

export class LinkConnectionsDto {
  @IsString()
  @IsNotEmpty()
  customerId: string;

  @IsString()
  @IsNotEmpty()
  supplierId: string;
}
