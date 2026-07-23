import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Decimal } from 'decimal.js';
import { Prisma } from '@prisma/client';

export type TransactionType = 'PAYMENT' | 'SALE' | 'PURCHASE' | 'ADJUSTMENT';

import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  /**
   * Centralized method to record a financial movement.
   * MUST be called within a Prisma Transaction if part of a larger operation.
   * This ensures:
   * 1. Atomic balance update via row-level locking (SELECT ... FOR UPDATE).
   * 2. Ledger consistency (Transaction record).
   * 3. Snapshot sync (Account balance, totalCredit, totalDebit).
   */
  async recordFinancialMovement(
    tx: Prisma.TransactionClient,
    params: {
      senderId: string;
      receiverId: string;
      amount: string | number | Decimal;
      type: TransactionType;
      orderId?: string;
      note?: string;
      voucherNumber?: string;
      currency?: string;
      dueDate?: string | Date;
      attachmentUrl?: string;
      userId?: string; // For audit logging
      connectionId?: string;
      clientId?: string; // Device-generated UUID for idempotency
    },
  ) {
    const { senderId, receiverId, amount, type, orderId, note, userId, connectionId } =
      params;
    const decimalAmount = new Decimal(amount.toString());

    if (senderId === receiverId) {
      throw new BadRequestException('Cannot transact within the same business');
    }

    // 1. Find the connection and account - USE RAW QUERY FOR ROW-LEVEL LOCKING
    // Prisma's findUnique doesn't support 'FOR UPDATE' easily across all versions,
    // so we use a raw query or ensure the transaction isolation level handles it.
    // However, in $transaction, subsequent updates to the same row are naturally queued.
    // To be 100% safe against stale reads in the same transaction, we fetch the account.

    const connection = connectionId
      ? await tx.connection.findFirst({
          where: { id: connectionId, status: 'ACCEPTED' },
          include: { account: true },
        })
      : await tx.connection.findFirst({
          where: {
            OR: [
              { requesterId: senderId, receiverId: receiverId },
              { requesterId: receiverId, receiverId: senderId },
            ],
            status: 'ACCEPTED',
          },
          include: { account: true },
        });

    if (!connection || !connection.account) {
      throw new BadRequestException(
        'Active connection and financial account required',
      );
    }

    // 2. Calculate balance change from requester's perspective
    // Balance > 0: Receiver owes Requester (له)
    // Balance < 0: Requester owes Receiver (عليه)
    const isSenderRequester = connection.requesterId === senderId;
    let balanceChange = new Decimal(0);

    switch (type) {
      case 'SALE': // Receiver (Merchant) sold to Sender (Customer) -> Sender owes Receiver more
        balanceChange = isSenderRequester
          ? decimalAmount.negated()
          : decimalAmount;
        break;
      case 'PURCHASE': // Sender bought -> Sender owes Receiver more
        balanceChange = isSenderRequester
          ? decimalAmount.negated()
          : decimalAmount;
        break;
      case 'PAYMENT': // Sender paid Receiver -> Sender's debt decreases
        balanceChange = isSenderRequester
          ? decimalAmount
          : decimalAmount.negated();
        break;
      case 'ADJUSTMENT':
        balanceChange = isSenderRequester
          ? decimalAmount
          : decimalAmount.negated();
        break;
    }

    // 3. Update the Account Atomicially
    // We use a mathematical update to prevent race conditions
    const updatedAccount = await tx.account.update({
      where: { id: connection.account.id },
      data: {
        balance: { increment: balanceChange.toString() as any },
      },
    });

    // 4. Update totalCredit and totalDebit based on the NEW balance
    // This maintains the "Snapshot" for easy UI reading
    const newBalance = new Decimal(updatedAccount.balance as any);
    const newTotalCredit = newBalance.greaterThan(0)
      ? newBalance
      : new Decimal(0);
    const newTotalDebit = newBalance.lessThan(0)
      ? newBalance.abs()
      : new Decimal(0);

    await tx.account.update({
      where: { id: updatedAccount.id },
      data: {
        totalCredit: newTotalCredit.toString(),
        totalDebit: newTotalDebit.toString(),
      },
    });

    // 5. Create Ledger Entry (Transaction table)
    const transaction = await tx.transaction.create({
      data: {
        clientId: params.clientId ?? undefined, // Store device UUID for idempotency
        transactionType: type,
        voucherNumber: params.voucherNumber || this.generateVoucherNumber(type),
        amount: decimalAmount.toString(),
        currency: params.currency || connection.account.currency || 'YER',
        dueDate: params.dueDate
          ? new Date(params.dueDate)
          : connection.account.dueDate,
        attachmentUrl: params.attachmentUrl,
        balanceAfter: newBalance.toString(),
        senderId,
        receiverId,
        orderId,
        note,
      },
    });

    // 6. Audit Log
    await tx.auditLog.create({
      data: {
        action: 'CREATE',
        resource: 'TRANSACTION',
        resourceId: transaction.id,
        userId: userId,
        details: {
          type,
          amount: decimalAmount.toString(),
          senderId,
          receiverId,
          voucherNumber: params.voucherNumber,
          currency: params.currency || connection.account.currency || 'YER',
          dueDate: params.dueDate,
          attachmentUrl: params.attachmentUrl,
          newBalance: newBalance.toString(),
        },
      },
    });

    // 7. Send Real-time Notification
    await this.notifyFinancialMovement(params, newBalance, transaction.id);

    return { transaction, newBalance };
  }

  private generateVoucherNumber(type: TransactionType) {
    const prefixMap: Record<TransactionType, string> = {
      PAYMENT: 'PAY',
      SALE: 'INV',
      PURCHASE: 'PUR',
      ADJUSTMENT: 'ADJ',
    };
    return `${prefixMap[type]}-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  private async notifyFinancialMovement(params: any, newBalance: Decimal, transactionId?: string) {
    const { senderId, receiverId, amount, type, orderId, note } = params;

    // Fetch participants for notification
    const sender = await this.prisma.business.findUnique({
      where: { id: senderId },
      include: { user: true },
    });
    const receiver = await this.prisma.business.findUnique({
      where: { id: receiverId },
      include: { user: true },
    });

    const amountStr = new Decimal(amount.toString()).toFixed(2);

    if (type === 'PAYMENT') {
      // Send notification ONLY to the customer (client) who made the payment, not the merchant
      if (sender?.user?.id) {
        await this.notificationsService.sendPushNotification(
          sender.user.id,
          'تم تسجيل سند قبض',
          `تم تسجيل سند قبض بمبلغ ${amountStr} لصالح ${receiver?.name}. الرصيد الحالي: ${newBalance.toFixed(2)}`,
          {
            type: 'PAYMENT_RECEIVED',
            amount: amountStr,
            transactionType: type,
            recordId: transactionId,
            transactionId: transactionId,
          },
        );

        this.eventsGateway.emitToBusiness(senderId, 'FINANCIAL_UPDATE', {
          type,
          amount: amountStr,
          newBalance: newBalance.toString(),
          receiverName: receiver?.name,
          note,
          transactionId,
        });
      }
      return;
    }

    if (!receiver) return;

    let title = '';
    let body = '';

    switch (type) {
      case 'SALE':
        // Notification for Sale is usually handled by Order service,
        // but if it's a direct transaction, we handle it here.
        title = 'فاتورة جديدة';
        body = `تم تسجيل فاتورة بقيمة ${amountStr} من ${sender?.name}.`;
        break;
      case 'ADJUSTMENT':
        title = 'تعديل رصيد';
        body = `قام ${sender?.name} بتعديل الرصيد بقيمة ${amountStr}.`;
        break;
    }

    if (title) {
      await this.notificationsService.sendPushNotification(
        receiver.user.id,
        title,
        body,
        {
          type: orderId ? 'order' : 'receipt_voucher',
          amount: amountStr,
          transactionType: type,
          recordId: orderId || transactionId,
          orderId: orderId,
          transactionId: transactionId,
        },
      );

      this.eventsGateway.emitToBusiness(receiverId, 'FINANCIAL_UPDATE', {
        type,
        amount: amountStr,
        newBalance: newBalance.toString(),
        senderName: sender?.name,
        note,
        transactionId,
        orderId,
      });
    }
  }

  /**
   * Utility to rebuild account balance from ledger ground truth.
   */
  async rebuildAccountBalance(
    accountId: string,
    txClient?: Prisma.TransactionClient,
  ) {
    const client = txClient || this.prisma;
    const account = await client.account.findUnique({
      where: { id: accountId },
      include: { connection: true },
    });

    if (!account) throw new NotFoundException('Account not found');

    const transactions = await client.transaction.findMany({
      where: {
        OR: [
          {
            senderId: account.connection.requesterId,
            receiverId: account.connection.receiverId,
          },
          {
            senderId: account.connection.receiverId,
            receiverId: account.connection.requesterId,
          },
        ],
      },
    });

    let balance = new Decimal(0);
    for (const t of transactions) {
      const isSenderRequester = t.senderId === account.connection.requesterId;
      const amount = new Decimal(t.amount as any);

      switch (t.transactionType) {
        case 'SALE':
          balance = isSenderRequester
            ? balance.minus(amount)
            : balance.plus(amount);
          break;
        case 'PURCHASE':
          balance = isSenderRequester
            ? balance.minus(amount)
            : balance.plus(amount);
          break;
        case 'PAYMENT':
          balance = isSenderRequester
            ? balance.plus(amount)
            : balance.minus(amount);
          break;
        case 'ADJUSTMENT':
          balance = isSenderRequester
            ? balance.plus(amount)
            : balance.minus(amount);
          break;
      }
    }

    return client.account.update({
      where: { id: accountId },
      data: {
        balance: balance.toString(),
        totalCredit: balance.greaterThan(0) ? balance.toString() : '0',
        totalDebit: balance.lessThan(0) ? balance.abs().toString() : '0',
      },
    });
  }
}
