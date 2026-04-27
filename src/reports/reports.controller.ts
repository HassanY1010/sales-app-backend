import { Controller, Get, UseGuards, ForbiddenException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { Roles } from '../core/decorators/roles.decorator';

@Controller('api/v1/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('business')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('debts')
  async getDebts(@CurrentUser() user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getDebtsToMe(user.businessId);
  }

  @Get('creditors')
  async getCreditors(@CurrentUser() user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getMyDebts(user.businessId);
  }

  @Get('summary')
  async getSummary(@CurrentUser() user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getSummary(user.businessId);
  }

  @Get('activity')
  async getRecentActivity(@CurrentUser() user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getRecentActivity(user.businessId);
  }

  @Get('weekly-sales')
  async getWeeklySales(@CurrentUser() user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getWeeklySalesData(user.businessId);
  }
}
