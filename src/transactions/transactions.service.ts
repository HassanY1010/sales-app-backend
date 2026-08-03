import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { GetTransactionsDto } from './dto/get-transactions.dto';
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

    // ── Idempotency guard: if this clientId was already processed, return existing ──
    if (dto.clientId) {
      const existing = await this.prisma.transaction.findUnique({
        where: { clientId: dto.clientId },
        include: { sender: true, receiver: true, order: true },
      });
      if (existing) {
        return existing; // Duplicate request — safe to return existing record
      }
    }

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
          connectionId: dto.connectionId,
          clientId: dto.clientId, // Pass through for storage
        },
      );

      // Persist payment-method metadata if provided
      if (dto['paymentMethod'] || dto['transferNumber']) {
        await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            paymentMethod: (dto as any).paymentMethod ?? undefined,
            transferNumber: (dto as any).transferNumber ?? undefined,
          },
        });
      }

      return transaction;
    });
  }


  async getTransactions(businessId: string, query: GetTransactionsDto) {
    const { page = 1, limit = 10, relatedBusinessId, connectionId, type } = query;

    const where: any = {
      OR: [{ senderId: businessId }, { receiverId: businessId }],
    };

    if (connectionId) {
      where.connectionId = connectionId;
    } else if (relatedBusinessId) {
      where.OR = [
        { senderId: businessId, receiverId: relatedBusinessId },
        { senderId: relatedBusinessId, receiverId: businessId },
      ];
    }

    // Filter: by transaction type (skip if 'all')
    if (type && type !== 'all') {
      where.transactionType = type;
    }

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
        relatedUserId:
          transaction.senderId === businessId
            ? transaction.receiverId
            : transaction.senderId,
        relatedUserName:
          transaction.senderId === businessId
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

  async getTransactionById(businessId: string, id: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
      include: {
        sender: true,
        receiver: true,
        order: true,
      },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');

    if (
      transaction.senderId !== businessId &&
      transaction.receiverId !== businessId
    ) {
      throw new ForbiddenException(
        'You do not have access to this transaction',
      );
    }

    return {
      ...transaction,
      direction: transaction.receiverId === businessId ? 'credit' : 'debit',
      relatedUserId:
        transaction.senderId === businessId
          ? transaction.receiverId
          : transaction.senderId,
      relatedUserName:
        transaction.senderId === businessId
          ? transaction.receiver.name
          : transaction.sender.name,
    };
  }

  async updateTransaction(
    businessId: string,
    userId: string,
    id: string,
    dto: UpdateTransactionDto,
  ) {
    // 1. Find the transaction and verify ownership
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');

    if (
      transaction.senderId !== businessId &&
      transaction.receiverId !== businessId
    ) {
      throw new ForbiddenException(
        'You do not have access to this transaction',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 2. Compute new amount if provided
      const newAmount = dto.amount
        ? new Decimal(dto.amount)
        : new Decimal(transaction.amount as any);

      // 3. Update the transaction record
      const updated = await tx.transaction.update({
        where: { id },
        data: {
          amount: newAmount.toString(),
          note: dto.note ?? transaction.note,
          voucherNumber: dto.voucherNumber ?? transaction.voucherNumber,
          currency: dto.currency ?? transaction.currency,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : transaction.dueDate,
          attachmentUrl: dto.attachmentUrl ?? transaction.attachmentUrl,
          paymentMethod:
            dto.paymentMethod ?? (transaction as any).paymentMethod,
          transferNumber:
            dto.transferNumber ?? (transaction as any).transferNumber,
        },
      });

      // 4. If amount changed, rebuild the account balance from the ledger
      if (dto.amount) {
        // Find the account associated with these two parties
        const connection = await tx.connection.findFirst({
          where: {
            OR: [
              {
                requesterId: transaction.senderId,
                receiverId: transaction.receiverId,
              },
              {
                requesterId: transaction.receiverId,
                receiverId: transaction.senderId,
              },
            ],
            status: 'ACCEPTED',
          },
          include: { account: true },
        });

        if (connection?.account) {
          const rebuiltAccount = await this.financeService.rebuildAccountBalance(
            connection.account.id,
            tx,
          );
          if (rebuiltAccount) {
            const creditLimit = new Decimal(rebuiltAccount.creditLimit as any);
            const currentDebit = new Decimal(rebuiltAccount.totalDebit as any);

            if (creditLimit.greaterThan(0) && currentDebit.greaterThan(creditLimit)) {
              throw new BadRequestException(
                `تعذر تعديل السند: القيمة الجديدة تؤدي لتجاوز سقف المديونية للعميل. سقف المديونية: ${creditLimit.toFixed(2)}، الرصيد بعد التعديل: ${currentDebit.toFixed(2)}.`
              );
            }
          }
        }
      }

      // 5. Audit log
      await tx.auditLog.create({
        data: {
          userId,
          businessId,
          action: 'UPDATE',
          resource: 'TRANSACTION',
          resourceId: id,
          details: {
            previousAmount: transaction.amount?.toString(),
            newAmount: newAmount.toString(),
            voucherNumber: updated.voucherNumber,
          },
        },
      });

      return updated;
    });
  }

  async deleteTransaction(businessId: string, userId: string, id: string) {
    // 1. Find the transaction and verify ownership
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');

    if (
      transaction.senderId !== businessId &&
      transaction.receiverId !== businessId
    ) {
      throw new ForbiddenException(
        'You do not have access to this transaction',
      );
    }

    // 2. Find the related account before deleting
    const connection = await this.prisma.connection.findFirst({
      where: {
        OR: [
          {
            requesterId: transaction.senderId,
            receiverId: transaction.receiverId,
          },
          {
            requesterId: transaction.receiverId,
            receiverId: transaction.senderId,
          },
        ],
        status: 'ACCEPTED',
      },
      include: { account: true },
    });

    return this.prisma.$transaction(async (tx) => {
      // 3. Audit log BEFORE delete (so we have the data)
      await tx.auditLog.create({
        data: {
          userId,
          businessId,
          action: 'DELETE',
          resource: 'TRANSACTION',
          resourceId: id,
          details: {
            transactionType: transaction.transactionType,
            amount: transaction.amount?.toString(),
            voucherNumber: transaction.voucherNumber,
            senderId: transaction.senderId,
            receiverId: transaction.receiverId,
          },
        },
      });

      // 4. Delete the transaction record
      await tx.transaction.delete({ where: { id } });

      // 5. Rebuild balance from ledger ground truth
      if (connection?.account) {
        await this.financeService.rebuildAccountBalance(
          connection.account.id,
          tx,
        );
      }

      return { success: true, message: 'Transaction deleted successfully' };
    });
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
      if (transaction.receiverId === businessId)
        received = received.plus(amount);
      if (transaction.transactionType === 'PAYMENT')
        payments = payments.plus(amount);
      if (['SALE', 'PURCHASE'].includes(transaction.transactionType))
        sales = sales.plus(amount);
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
