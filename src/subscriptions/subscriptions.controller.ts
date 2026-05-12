import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { CreatePaymentRequestDto } from './dto/create-payment-request.dto';
import { ApprovePaymentDto } from './dto/approve-payment.dto';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Post('payment-report')
  @UseGuards(JwtAuthGuard)
  async paymentReport(@Request() req: any, @Body() dto: CreatePaymentRequestDto) {
    return this.subscriptionsService.createPaymentRequest(req.user.userId, dto);
  }

  @Get('check-subscription')
  @UseGuards(JwtAuthGuard)
  async checkSubscription(@Request() req: any) {
    return this.subscriptionsService.checkSubscription(req.user.userId);
  }

  @Get('pending-requests')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  async getPendingRequests(@Query('page') page = 1, @Query('limit') limit = 20) {
    return this.subscriptionsService.getPendingRequests(page, limit);
  }

  @Put('approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async approvePayment(@Request() req: any, @Body() dto: ApprovePaymentDto) {
    return this.subscriptionsService.approvePayment(dto.requestId, req.user.userId, dto.notes);
  }

  @Put('reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async rejectPayment(
    @Request() req: any,
    @Body() dto: { requestId: string; reason?: string },
  ) {
    return this.subscriptionsService.rejectPayment(dto.requestId, req.user.userId, dto.reason);
  }

  @Post('extend/:businessId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async extendSubscription(
    @Param('businessId') businessId: string, 
    @Request() req: any,
    @Body() dto: { days?: number }
  ) {
    return this.subscriptionsService.extendSubscription(businessId, req.user.userId, dto?.days);
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  async getStats() {
    return this.subscriptionsService.getSubscriptionStats();
  }
}