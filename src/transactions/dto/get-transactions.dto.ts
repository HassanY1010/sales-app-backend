import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class GetTransactionsDto extends PaginationDto {
  /** Filter by the other party's business ID */
  @IsString()
  @IsOptional()
  relatedBusinessId?: string;

  /** Filter by transaction type */
  @IsEnum(['PAYMENT', 'SALE', 'PURCHASE', 'ADJUSTMENT', 'all'])
  @IsOptional()
  type?: 'PAYMENT' | 'SALE' | 'PURCHASE' | 'ADJUSTMENT' | 'all';
}
