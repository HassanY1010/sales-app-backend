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
import { AuditService } from '../audit/audit.service';

@Controller('transactions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('business', 'individual')
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly auditService: AuditService,
  ) {}

  @Post()
  @Roles('business')
  async createTransaction(
    @CurrentUser() user: any,
    @Body() dto: CreateTransactionDto,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    const transaction = await this.transactionsService.createTransaction(user.businessId, dto);
    await this.auditService.record({
      userId: user.userId,
      businessId: user.businessId,
      action: 'CREATE',
      resource: 'TRANSACTION',
      resourceId: transaction.id,
      details: {
        transactionType: transaction.transactionType,
        amount: transaction.amount?.toString(),
        voucherNumber: transaction.voucherNumber,
        receiverId: transaction.receiverId,
        senderId: transaction.senderId,
        sourceScreen: dto.sourceScreen ?? 'DIRECT',
      },
    });
    return transaction;
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

  @Get(':id')
  async getTransactionById(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    const transaction = await this.transactionsService.getTransactionById(user.businessId, id);

    await this.auditService.record({
      userId: user.userId,
      businessId: user.businessId,
      action: 'OPEN',
      resource: 'TRANSACTION',
      resourceId: id,
      details: {
        voucherNumber: transaction.voucherNumber,
        transactionType: transaction.transactionType,
      },
    });

    return transaction;
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
