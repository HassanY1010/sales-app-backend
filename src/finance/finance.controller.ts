import { Controller, Post, Param, UseGuards } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';

@Controller('finance')
@UseGuards(JwtAuthGuard)
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  @Post('rebuild-balance/:accountId')
  async rebuildBalance(@Param('accountId') accountId: string) {
    return this.financeService.rebuildAccountBalance(accountId);
  }
}
