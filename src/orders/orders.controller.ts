import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { Roles } from '../core/decorators/roles.decorator';

@Controller('api/v1/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('business') // Must be a business
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  async createOrder(@CurrentUser() user: any, @Body() dto: CreateOrderDto) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.ordersService.createOrder(user.businessId, dto);
  }

  @Get()
  async getOrders(
    @CurrentUser() user: any,
    @Query() pagination: PaginationDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.ordersService.getOrders(user.businessId, pagination);
  }

  @Get(':id')
  async getOrderById(@CurrentUser() user: any, @Param('id') id: string) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.ordersService.getOrderById(user.businessId, id);
  }

  @Patch(':id/status')
  async updateOrderStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.ordersService.updateOrderStatus(user.businessId, id, dto);
  }
}
