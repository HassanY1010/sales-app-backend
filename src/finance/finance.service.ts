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
      accountRole?: 'CUSTOMER' | 'SUPPLIER';
      clientId?: string; // Device-generated UUID for idempotency
    },
  ) {
    const { senderId, receiverId, amount, type, orderId, note, userId, connectionId, accountRole } =
      params;
    const decimalAmount = new Decimal(amount.toString());

    if (senderId === receiverId) {
      throw new BadRequestException('Cannot transact within the same business');
    }

    const expectedRole = accountRole || (type === 'SALE' ? 'CUSTOMER' : type === 'PURCHASE' ? 'SUPPLIER' : undefined);
    const allowedStatuses = ['ACCEPTED', 'ACTIVE', 'accepted', 'active'];

    let connection = connectionId
      ? await tx.connection.findFirst({
          where: { id: connectionId, status: { in: allowedStatuses } },
          include: { account: true },
        })
      : null;

    if (connection) {
      // Validate that connection belongs to transacting parties
      const isParty =
        (connection.requesterId === senderId && connection.receiverId === receiverId) ||
        (connection.requesterId === receiverId && connection.receiverId === senderId);
      
      if (!isParty) {
        // Check if receiverId was userId
        const receiverBiz = await tx.business.findFirst({
          where: { OR: [{ id: receiverId }, { userId: receiverId }] },
          select: { id: true },
        });
        const actualBizId = receiverBiz?.id || receiverId;
        const isPartyWithBiz =
          (connection.requesterId === senderId && connection.receiverId === actualBizId) ||
          (connection.requesterId === actualBizId && connection.receiverId === senderId);

        if (!isPartyWithBiz) {
          throw new BadRequestException('الارتباط المحدد لا يخص أطراف هذه المعاملة');
        }
      }

      const senderPerspectiveRole =
        connection.requesterId === senderId
          ? connection.connectionType
          : (connection.connectionType === 'CUSTOMER' ? 'SUPPLIER' : 'CUSTOMER');

      if (expectedRole && senderPerspectiveRole !== expectedRole) {
        if (type === 'SALE') {
          throw new BadRequestException('لا يمكن تسجيل حركة مبيعات في حساب مورد');
        }
        if (type === 'PURCHASE') {
          throw new BadRequestException('لا يمكن تسجيل حركة مشتريات في حساب عميل');
        }
        throw new BadRequestException(`نوع الارتباط (${senderPerspectiveRole}) لا يتطابق مع الدور المطلوب (${expectedRole})`);
      }
    }

    if (!connection) {
      // 1. Check direct connection by business IDs with strict role separation
      const orClauses: any[] = [];
      if (expectedRole === 'CUSTOMER') {
        orClauses.push(
          { requesterId: senderId, receiverId: receiverId, connectionType: 'CUSTOMER' },
          { requesterId: receiverId, receiverId: senderId, connectionType: 'SUPPLIER' },
        );
      } else if (expectedRole === 'SUPPLIER') {
        orClauses.push(
          { requesterId: senderId, receiverId: receiverId, connectionType: 'SUPPLIER' },
          { requesterId: receiverId, receiverId: senderId, connectionType: 'CUSTOMER' },
        );
      } else {
        orClauses.push(
          { requesterId: senderId, receiverId: receiverId },
          { requesterId: receiverId, receiverId: senderId },
        );
      }

      connection = await tx.connection.findFirst({
        where: {
          status: { in: allowedStatuses },
          OR: orClauses,
        },
        include: { account: true },
      });
    }

    if (!connection) {
      // 2. Check if receiverId is user.id
      const receiverBiz = await tx.business.findFirst({
        where: { OR: [{ id: receiverId }, { userId: receiverId }] },
        select: { id: true },
      });
      if (receiverBiz?.id) {
        const orClauses: any[] = [];
        if (expectedRole === 'CUSTOMER') {
          orClauses.push(
            { requesterId: senderId, receiverId: receiverBiz.id, connectionType: 'CUSTOMER' },
            { requesterId: receiverBiz.id, receiverId: senderId, connectionType: 'SUPPLIER' },
          );
        } else if (expectedRole === 'SUPPLIER') {
          orClauses.push(
            { requesterId: senderId, receiverId: receiverBiz.id, connectionType: 'SUPPLIER' },
            { requesterId: receiverBiz.id, receiverId: senderId, connectionType: 'CUSTOMER' },
          );
        } else {
          orClauses.push(
            { requesterId: senderId, receiverId: receiverBiz.id },
            { requesterId: receiverBiz.id, receiverId: senderId },
          );
        }

        connection = await tx.connection.findFirst({
          where: {
            status: { in: allowedStatuses },
            OR: orClauses,
          },
          include: { account: true },
        });
      }
    }

    if (!connection) {
      // 3. Check if receiverId is a CustomerSupplierLink
      const link = await tx.customerSupplierLink.findFirst({
        where: {
          OR: [{ id: receiverId }, { customerId: receiverId }, { supplierId: receiverId }],
          status: { in: allowedStatuses },
        },
        include: {
          customer: { include: { account: true } },
          supplier: { include: { account: true } },
        },
      });
      if (link) {
        if (expectedRole === 'CUSTOMER' && link.customer?.account) {
          connection = link.customer;
        } else if (expectedRole === 'SUPPLIER' && link.supplier?.account) {
          connection = link.supplier;
        } else if (link.customer?.account) {
          connection = link.customer;
        } else if (link.supplier?.account) {
          connection = link.supplier;
        }
      }
    }

    if (!connection || !connection.account) {
      throw new BadRequestException(
        'Active connection and financial account required',
      );
    }

    const senderPerspectiveRole =
      connection.requesterId === senderId
        ? connection.connectionType
        : (connection.connectionType === 'CUSTOMER' ? 'SUPPLIER' : 'CUSTOMER');

    if (type === 'SALE' && senderPerspectiveRole === 'SUPPLIER') {
      throw new BadRequestException('لا يمكن تسجيل حركة مبيعات في حساب مورد');
    }
    if (type === 'PURCHASE' && senderPerspectiveRole === 'CUSTOMER') {
      throw new BadRequestException('لا يمكن تسجيل حركة مشتريات في حساب عميل');
    }

    // 2. Calculate balance change from requester's perspective
    // Balance Direction:
    // Positive balance (> 0):
    //   - For CUSTOMER: Customer owes Merchant (عليه - مديونية العميل)
    //   - For SUPPLIER: Merchant owes Supplier (له - مديونية للمورد)
    // Negative balance (< 0):
    //   - For CUSTOMER: Merchant owes Customer (له - رصيد دائن للعميل)
    //   - For SUPPLIER: Supplier owes Merchant (عليه - مديونية على المورد)
    const isSenderRequester = connection.requesterId === senderId;
    let balanceChange = new Decimal(0);

    switch (type) {
      case 'SALE': // Merchant sold on credit -> Customer debt increases (+amount)
        balanceChange = isSenderRequester
          ? decimalAmount
          : decimalAmount.negated();
        break;
      case 'PURCHASE': // Merchant bought on credit -> Supplier credit increases (+amount)
        balanceChange = isSenderRequester
          ? decimalAmount
          : decimalAmount.negated();
        break;
      case 'PAYMENT': // Payment reduces debt/credit (-amount)
        balanceChange = decimalAmount.negated();
        break;
      case 'ADJUSTMENT': // Opening balance / Adjustment (+amount)
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

    // 4. Update totalCredit and totalDebit based on the NEW balance and Connection Perspective
    const newBalance = new Decimal(updatedAccount.balance?.toString() ?? '0');
    const isCustomer = connection.connectionType === 'CUSTOMER';
    const numBalance = newBalance.toNumber();

    let newTotalCredit = new Decimal(0);
    let newTotalDebit = new Decimal(0);

    if (isCustomer) {
      // Customer: balance > 0 = عليه (totalDebit), balance < 0 = له (totalCredit)
      if (numBalance > 0) newTotalDebit = newBalance;
      if (numBalance < 0) newTotalCredit = newBalance.abs();
    } else {
      // Supplier: balance > 0 = له (totalCredit), balance < 0 = عليه (totalDebit)
      if (numBalance > 0) newTotalCredit = newBalance;
      if (numBalance < 0) newTotalDebit = newBalance.abs();
    }

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
        connectionId: connection.id,
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
        businessId: senderId,
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
        const isOpening = note?.includes('افتتاحي') ?? false;
        title = isOpening ? 'رصيد افتتاحي' : 'تعديل رصيد';
        body = isOpening
          ? `تم تحديد رصيد افتتاحي بقيمة ${amountStr} لصالح ${sender?.name}.`
          : `قام ${sender?.name} بتعديل الرصيد بقيمة ${amountStr}.`;
        break;
    }

    if (title) {
      const notificationType = type === 'ADJUSTMENT' ? 'OPENING_BALANCE' : (orderId ? 'order' : 'receipt_voucher');
      await this.notificationsService.sendPushNotification(
        receiver.user.id,
        title,
        body,
        {
          type: notificationType,
          notificationType: notificationType,
          entityType: type === 'ADJUSTMENT' ? 'opening_balance' : (orderId ? 'order' : 'invoice'),
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
    if (!account.connection.receiverId) return;
    const receiverId = account.connection.receiverId;

    const transactions = await client.transaction.findMany({
      where: {
        OR: [
          { connectionId: account.connectionId },
          {
            connectionId: null,
            OR: [
              { senderId: account.connection.requesterId, receiverId },
              { senderId: receiverId, receiverId: account.connection.requesterId },
            ],
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
            ? balance.plus(amount)
            : balance.minus(amount);
          break;
        case 'PURCHASE':
          balance = isSenderRequester
            ? balance.plus(amount)
            : balance.minus(amount);
          break;
        case 'PAYMENT':
          balance = balance.minus(amount);
          break;
        case 'ADJUSTMENT':
          balance = isSenderRequester
            ? balance.plus(amount)
            : balance.minus(amount);
          break;
      }
    }

    const isCustomer = account.connection.connectionType === 'CUSTOMER';
    const numBalance = balance.toNumber();

    let totalDebit = '0';
    let totalCredit = '0';

    if (isCustomer) {
      // Customer: balance > 0 = عليه (totalDebit), balance < 0 = له (totalCredit)
      if (numBalance > 0) totalDebit = balance.toString();
      if (numBalance < 0) totalCredit = balance.abs().toString();
    } else {
      // Supplier: balance > 0 = له (totalCredit), balance < 0 = عليه (totalDebit)
      if (numBalance > 0) totalCredit = balance.toString();
      if (numBalance < 0) totalDebit = balance.abs().toString();
    }

    return client.account.update({
      where: { id: accountId },
      data: {
        balance: balance.toString(),
        totalDebit,
        totalCredit,
      },
    });
  }
}
