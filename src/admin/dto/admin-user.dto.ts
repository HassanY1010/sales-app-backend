import {
  IsOptional,
  IsString,
  IsEnum,
  IsBoolean,
  IsDateString,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class AdminUsersQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  userType?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isActive?: boolean;

  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt';

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}

export class ChangeUserRoleDto {
  @IsString()
  userId: string;

  @IsEnum(['SUPER_ADMIN', 'ADMIN', 'SUPPORT'])
  role: 'SUPER_ADMIN' | 'ADMIN' | 'SUPPORT';
}

export class ToggleUserStatusDto {
  @IsString()
  userId: string;

  @IsBoolean()
  @Type(() => Boolean)
  isActive: boolean;
}
