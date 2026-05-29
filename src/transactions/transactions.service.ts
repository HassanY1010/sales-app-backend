import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { FinanceService } from '../finance/finance.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import Decimal from 'decimal.js';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly financeService: FinanceService,
  ) {}

  async createTransaction(senderId: string, dto: CreateTransactionDto) {
    const recordsReceivedPayment =
      dto.transactionType === 'PAYMENT' && dto.paymentDirection === 'RECEIVED';
    const actualSenderId = recordsReceivedPayment ? dto.receiverId : senderId;
    const actualReceiverId = recordsReceivedPayment ? senderId : dto.receiverId;

    // Perform atomic transaction wrapping the movement
    return this.prisma.$transaction(async (tx) => {
      const { transaction } = await this.financeService.recordFinancialMovement(
        tx,
        {
          senderId: actualSenderId,
          receiverId: actualReceiverId,
          amount: dto.amount,
          type: dto.transactionType as any,
          orderId: dto.orderId,
          note: dto.note,
          voucherNumber: dto.voucherNumber,
          currency: dto.currency,
          dueDate: dto.dueDate,
          attachmentUrl: dto.attachmentUrl,
        },
      );

      return transaction;
    });
  }

  async getTransactions(businessId: string, pagination: PaginationDto) {
    const { page = 1, limit = 10 } = pagination;
    const where = {
      OR: [{ senderId: businessId }, { receiverId: businessId }],
    };

    const [data, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: {
          sender: true,
          receiver: true,
          order: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      data: data.map((transaction) => ({
        ...transaction,
        direction: transaction.receiverId === businessId ? 'credit' : 'debit',
        relatedUserId: transaction.senderId === businessId ? transaction.receiverId : transaction.senderId,
        relatedUserName: transaction.senderId === businessId
          ? transaction.receiver.name
          : transaction.sender.name,
      })),
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
        limit,
      },
    };
  }

  async getTransactionsSummary(businessId: string) {
    const transactions = await this.prisma.transaction.findMany({
      where: {
        OR: [{ senderId: businessId }, { receiverId: businessId }],
      },
      select: {
        senderId: true,
        receiverId: true,
        transactionType: true,
        amount: true,
      },
    });

    let sent = new Decimal(0);
    let received = new Decimal(0);
    let payments = new Decimal(0);
    let sales = new Decimal(0);

    for (const transaction of transactions) {
      const amount = new Decimal(transaction.amount as any);
      if (transaction.senderId === businessId) sent = sent.plus(amount);
      if (transaction.receiverId === businessId) received = received.plus(amount);
      if (transaction.transactionType === 'PAYMENT') payments = payments.plus(amount);
      if (['SALE', 'PURCHASE'].includes(transaction.transactionType)) sales = sales.plus(amount);
    }

    return {
      count: transactions.length,
      sent: sent.toString(),
      received: received.toString(),
      payments: payments.toString(),
      sales: sales.toString(),
    };
  }
}
