import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { AdjustmentRequestsService } from './adjustment-requests.service';
import { CreateAdjustmentRequestDto } from './dto/create-adjustment-request.dto';
import { RejectAdjustmentRequestDto } from './dto/review-adjustment-request.dto';

@Controller('adjustment-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('business', 'individual')
export class AdjustmentRequestsController {
  constructor(private readonly service: AdjustmentRequestsService) {}

  @Post()
  async create(@CurrentUser() user: any, @Body() dto: CreateAdjustmentRequestDto) {
    this.ensureBusiness(user);
    return this.service.create(user.businessId, user.userId, dto);
  }

  @Get()
  async list(
    @CurrentUser() user: any,
    @Query() pagination: PaginationDto & { status?: string; targetType?: string },
  ) {
    this.ensureBusiness(user);
    return this.service.list(user.businessId, pagination);
  }

  @Get(':id')
  async getById(@CurrentUser() user: any, @Param('id') id: string) {
    this.ensureBusiness(user);
    return this.service.getById(user.businessId, id);
  }

  @Patch(':id/approve')
  async approve(@CurrentUser() user: any, @Param('id') id: string) {
    this.ensureBusiness(user);
    return this.service.approve(user.businessId, user.userId, id);
  }

  @Patch(':id/reject')
  async reject(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: RejectAdjustmentRequestDto,
  ) {
    this.ensureBusiness(user);
    return this.service.reject(user.businessId, user.userId, id, dto.rejectionReason);
  }

  private ensureBusiness(user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
  }
}
