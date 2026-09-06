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
import {
  UpdateOrderPricesDto,
  UpdateOrderStatusDto,
} from './dto/update-order-status.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { Roles } from '../core/decorators/roles.decorator';
import { AuditService } from '../audit/audit.service';

@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('business', 'individual') // Merchants and Consumers can both access orders
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly auditService: AuditService,
  ) {}

  @Post()
  async createOrder(@CurrentUser() user: any, @Body() dto: CreateOrderDto) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.ordersService.createOrder(user.businessId, dto, user.userType);
  }

  @Get('next-number')
  async getNextInvoiceNumber(
    @CurrentUser() user: any,
    @Query('type') type?: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    if (type === 'order' || type === 'purchase_order') {
      return this.ordersService.getNextOrderNumberPreview(user.businessId);
    }
    return this.ordersService.getNextInvoiceNumberPreview(user.businessId);
  }

  @Get('next-order-number')
  async getNextOrderNumber(@CurrentUser() user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.ordersService.getNextOrderNumberPreview(user.businessId);
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
    const order = await this.ordersService.getOrderById(user.businessId, id);

    await this.auditService.record({
      userId: user.userId,
      businessId: user.businessId,
      action: 'OPEN',
      resource: 'ORDER',
      resourceId: id,
      details: {
        documentNumber: order.orderNumber,
        status: order.status,
      },
    });

    return order;
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
    return this.ordersService.updateOrderStatus(
      user.businessId,
      id,
      dto,
      user.userType,
    );
  }

  @Patch(':id/prices')
  async updateOrderPrices(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateOrderPricesDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.ordersService.updateOrderPrices(
      user.businessId,
      id,
      dto,
      user.userType,
    );
  }
}
