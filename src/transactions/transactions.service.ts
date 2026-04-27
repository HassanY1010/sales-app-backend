import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { FinanceService } from '../finance/finance.service';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly financeService: FinanceService,
  ) {}

  async createTransaction(senderId: string, dto: CreateTransactionDto) {
    // Perform atomic transaction wrapping the movement
    return this.prisma.$transaction(async (tx) => {
      const { transaction } = await this.financeService.recordFinancialMovement(
        tx,
        {
          senderId,
          receiverId: dto.receiverId,
          amount: dto.amount,
          type: dto.transactionType as any,
          orderId: dto.orderId,
          note: dto.note,
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
      data,
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
        limit,
      },
    };
  }
}
