import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { IsString, IsNotEmpty } from 'class-validator';
import { SubscriptionsService } from './subscriptions.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { CreatePaymentRequestDto } from './dto/create-payment-request.dto';
import { ApprovePaymentDto } from './dto/approve-payment.dto';
import { CreatePlanDto } from './dto/create-plan.dto';

export class ActivateCodeDto {
  @IsString()
  @IsNotEmpty()
  code: string;
}

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Post('payment-report')
  @UseGuards(JwtAuthGuard)
  async paymentReport(
    @Request() req: any,
    @Body() dto: CreatePaymentRequestDto,
  ) {
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
  async getPendingRequests(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.subscriptionsService.getPendingRequests(page, limit);
  }

  @Put('approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async approvePayment(@Request() req: any, @Body() dto: ApprovePaymentDto) {
    return this.subscriptionsService.approvePayment(
      dto.requestId,
      req.user.userId,
      dto.notes,
    );
  }

  @Put('reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async rejectPayment(
    @Request() req: any,
    @Body() dto: { requestId: string; reason?: string },
  ) {
    return this.subscriptionsService.rejectPayment(
      dto.requestId,
      req.user.userId,
      dto.reason,
    );
  }

  @Post('extend/:businessId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async extendSubscription(
    @Param('businessId') businessId: string,
    @Request() req: any,
    @Body() dto: { days?: number },
  ) {
    return this.subscriptionsService.extendSubscription(
      businessId,
      req.user.userId,
      dto?.days,
    );
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  async getStats() {
    return this.subscriptionsService.getSubscriptionStats();
  }

  /** Activate subscription via a pre-generated code (Blocker-04) */
  @Post('activate')
  @UseGuards(JwtAuthGuard)
  async activateCode(@Request() req: any, @Body() dto: ActivateCodeDto) {
    return this.subscriptionsService.activateByCode(req.user.userId, dto.code);
  }

  /** List all subscription plans */
  @Get('plans')
  async getPlans() {
    return this.subscriptionsService.getPlans();
  }

  /** Get single subscription plan by id */
  @Get('plans/:id')
  async getPlanById(@Param('id') id: string) {
    return this.subscriptionsService.getPlanById(id);
  }

  /** Create subscription plan (Admin) */
  @Post('plans')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async createPlan(@Body() dto: CreatePlanDto) {
    return this.subscriptionsService.createPlan(dto);
  }

  /** Update subscription plan (Admin) */
  @Put('plans/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async updatePlan(
    @Param('id') id: string,
    @Body() dto: Partial<CreatePlanDto>,
  ) {
    return this.subscriptionsService.updatePlan(id, dto);
  }

  /** Delete subscription plan (Admin) */
  @Delete('plans/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async deletePlan(@Param('id') id: string) {
    return this.subscriptionsService.deletePlan(id);
  }

  // =========================================================================
  // ADMIN SUBSCRIPTION MANAGEMENT ENDPOINTS
  // =========================================================================

  @Get('admin/list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  async getAdminSubscriptionsList(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
    @Query('filter') filter?: string,
  ) {
    return this.subscriptionsService.getAdminSubscriptionsList({
      page,
      limit,
      search,
      filter,
    });
  }

  @Post('admin/renew')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async renewSubscriptionAdmin(
    @Request() req: any,
    @Body()
    dto: {
      businessId: string;
      durationType: 'MONTHLY' | '3_MONTHS' | '6_MONTHS' | 'YEARLY' | 'CUSTOM';
      customDays?: number;
      notes?: string;
    },
  ) {
    return this.subscriptionsService.renewSubscriptionAdmin(
      req.user.userId,
      dto,
    );
  }

  @Put('admin/modify-duration')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async modifySubscriptionDurationAdmin(
    @Request() req: any,
    @Body()
    dto: {
      businessId: string;
      endDate?: string;
      days?: number;
    },
  ) {
    return this.subscriptionsService.modifySubscriptionDurationAdmin(
      req.user.userId,
      dto,
    );
  }

  @Post('admin/suspend')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async suspendSubscriptionAdmin(
    @Request() req: any,
    @Body() dto: { businessId: string; reason?: string },
  ) {
    return this.subscriptionsService.suspendSubscriptionAdmin(
      req.user.userId,
      dto.businessId,
      dto.reason,
    );
  }

  @Post('admin/activate-subscription')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async activateSubscriptionAdmin(
    @Request() req: any,
    @Body() dto: { businessId: string },
  ) {
    return this.subscriptionsService.activateSubscriptionAdmin(
      req.user.userId,
      dto.businessId,
    );
  }

  @Post('admin/send-notification')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  async sendSubscriptionNotificationAdmin(
    @Request() req: any,
    @Body() dto: { userId: string; title: string; message: string },
  ) {
    return this.subscriptionsService.sendSubscriptionNotificationAdmin(
      req.user.userId,
      dto,
    );
  }

  @Get('admin/history/:businessId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  async getSubscriptionHistoryAdmin(@Param('businessId') businessId: string) {
    return this.subscriptionsService.getSubscriptionHistoryAdmin(businessId);
  }
}
