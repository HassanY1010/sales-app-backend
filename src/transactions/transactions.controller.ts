import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ForbiddenException,
  Query,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { GetTransactionsDto } from './dto/get-transactions.dto';
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
    @Query() query: GetTransactionsDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.transactionsService.getTransactions(user.businessId, query);
  }

  @Get('summary')
  async getTransactionsSummary(@CurrentUser() user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.transactionsService.getTransactionsSummary(user.businessId);
  }

  /** Edit a transaction (Blocker-01) */
  @Patch(':id')
  @Roles('business')
  async updateTransaction(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateTransactionDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.transactionsService.updateTransaction(
      user.businessId,
      user.userId,
      id,
      dto,
    );
  }

  /** Delete a transaction (Blocker-01) */
  @Delete(':id')
  @Roles('business')
  async deleteTransaction(@CurrentUser() user: any, @Param('id') id: string) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.transactionsService.deleteTransaction(
      user.businessId,
      user.userId,
      id,
    );
  }
}
