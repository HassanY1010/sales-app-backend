import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';

@Controller('monitoring')
@UseGuards(JwtAuthGuard)
export class MonitoringController {
  constructor(private readonly monitoringService: MonitoringService) {}

  @Get('audit-logs')
  async getAuditLogs(@CurrentUser() user: any, @Query('limit') limit?: string) {
    return this.monitoringService.getAuditLogs(user.userId, limit ? parseInt(limit, 10) : 50);
  }

  @Post('suggestions')
  async createSuggestion(
    @CurrentUser() user: any,
    @Body('content') content: string,
    @Body('whatsapp') whatsapp?: string,
  ) {
    return this.monitoringService.createSuggestion(user.userId, content, whatsapp);
  }

  @Get('subscription')
  async getSubscription(@CurrentUser() user: any) {
    return this.monitoringService.getSubscriptions(user.businessId);
  }
}
