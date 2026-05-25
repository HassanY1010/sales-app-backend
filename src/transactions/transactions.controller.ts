import { Controller, Post, Get, Body, UseGuards, ForbiddenException, Query } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { Roles } from '../core/decorators/roles.decorator';

@Controller('transactions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('business', 'individual')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  @Roles('business')
  async createTransaction(
    @CurrentUser() user: any,
    @Body() dto: CreateTransactionDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.transactionsService.createTransaction(user.businessId, dto);
  }

  @Get()
  async getTransactions(
    @CurrentUser() user: any,
    @Query() pagination: PaginationDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.transactionsService.getTransactions(user.businessId, pagination);
  }
}
