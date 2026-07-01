import {
  Controller,
  Get,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { Roles } from '../core/decorators/roles.decorator';

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('business', 'individual')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('debts')
  @Roles('business')
  async getDebts(@CurrentUser() user: any, @Query() query: any) {
    if (user.userType !== 'business') {
      throw new ForbiddenException(
        'Only business accounts can access debts report',
      );
    }
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getDebtsToMe(user.businessId, query);
  }

  @Get('creditors')
  async getCreditors(@CurrentUser() user: any, @Query() query: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getMyDebts(user.businessId, query);
  }

  @Get('summary')
  async getSummary(@CurrentUser() user: any, @Query() query: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getSummary(user.businessId, query);
  }

  @Get('orders')
  async getOrdersReport(@CurrentUser() user: any, @Query() query: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getOrdersReport(user.businessId, query);
  }

  @Get('transactions')
  async getTransactionsReport(@CurrentUser() user: any, @Query() query: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getTransactionsReport(user.businessId, query);
  }

  @Get('export')
  async exportReport(@CurrentUser() user: any, @Query() query: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.exportReport(user.businessId, query);
  }

  @Get('due-accounts')
  async getDueAccounts(@CurrentUser() user: any, @Query() query: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getDueAccounts(user.businessId, query);
  }

  @Get('activity')
  async getRecentActivity(@CurrentUser() user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getRecentActivity(user.businessId);
  }

  @Get('weekly-sales')
  @Roles('business')
  async getWeeklySales(@CurrentUser() user: any, @Query() query: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getWeeklySalesData(user.businessId, query);
  }

  @Get('expenses')
  async getExpensesReport(@CurrentUser() user: any, @Query() query: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.reportsService.getExpensesReport(user.businessId, query);
  }
}
