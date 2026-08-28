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
      initiatorBusinessId?: string; // The caller/creator business ID
    },
  ) {
    const { senderId, receiverId, amount, type, orderId, note, userId, connectionId, accountRole, initiatorBusinessId } =
      params;
    const decimalAmount = new Decimal(amount.toString());

    if (senderId === receiverId) {
      throw new BadRequestException('Cannot transact within the same business');
    }

    const initiator = initiatorBusinessId || senderId;
    const counterpart = (initiator === senderId) ? receiverId : senderId;

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
        // Check if receiverId or senderId was userId
        const counterpartBiz = await tx.business.findFirst({
          where: { OR: [{ id: counterpart }, { userId: counterpart }] },
          select: { id: true },
        });
        const actualCounterpartBizId = counterpartBiz?.id || counterpart;
        const isPartyWithBiz =
          (connection.requesterId === initiator && connection.receiverId === actualCounterpartBizId) ||
          (connection.requesterId === actualCounterpartBizId && connection.receiverId === initiator);

        if (!isPartyWithBiz) {
          throw new BadRequestException('الارتباط المحدد لا يخص أطراف هذه المعاملة');
        }
      }

      const initiatorPerspectiveRole =
        connection.requesterId === initiator
          ? connection.connectionType
          : (connection.connectionType === 'CUSTOMER' ? 'SUPPLIER' : 'CUSTOMER');

      if (expectedRole && initiatorPerspectiveRole !== expectedRole) {
        if (type === 'SALE') {
          throw new BadRequestException('لا يمكن تسجيل حركة مبيعات في حساب مورد');
        }
        if (type === 'PURCHASE') {
          throw new BadRequestException('لا يمكن تسجيل حركة مشتريات في حساب عميل');
        }
        throw new BadRequestException(`نوع الارتباط (${initiatorPerspectiveRole}) لا يتطابق مع الدور المطلوب (${expectedRole})`);
      }
    }

    if (!connection) {
      // 1. Check direct connection by initiator & counterpart with strict role separation
      const orClauses: any[] = [];
      if (expectedRole === 'CUSTOMER') {
        orClauses.push(
          { requesterId: initiator, receiverId: counterpart, connectionType: 'CUSTOMER' },
          { requesterId: counterpart, receiverId: initiator, connectionType: 'SUPPLIER' },
        );
      } else if (expectedRole === 'SUPPLIER') {
        orClauses.push(
          { requesterId: initiator, receiverId: counterpart, connectionType: 'SUPPLIER' },
          { requesterId: counterpart, receiverId: initiator, connectionType: 'CUSTOMER' },
        );
      } else {
        orClauses.push(
          { requesterId: initiator, receiverId: counterpart },
          { requesterId: counterpart, receiverId: initiator },
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
      // 2. Check if counterpart is user.id
      const counterpartBiz = await tx.business.findFirst({
        where: { OR: [{ id: counterpart }, { userId: counterpart }] },
        select: { id: true },
      });
      if (counterpartBiz?.id) {
        const orClauses: any[] = [];
        if (expectedRole === 'CUSTOMER') {
          orClauses.push(
            { requesterId: initiator, receiverId: counterpartBiz.id, connectionType: 'CUSTOMER' },
            { requesterId: counterpartBiz.id, receiverId: initiator, connectionType: 'SUPPLIER' },
          );
        } else if (expectedRole === 'SUPPLIER') {
          orClauses.push(
            { requesterId: initiator, receiverId: counterpartBiz.id, connectionType: 'SUPPLIER' },
            { requesterId: counterpartBiz.id, receiverId: initiator, connectionType: 'CUSTOMER' },
          );
        } else {
          orClauses.push(
            { requesterId: initiator, receiverId: counterpartBiz.id },
            { requesterId: counterpartBiz.id, receiverId: initiator },
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

    const initiatorPerspectiveRole =
      connection.requesterId === initiator
        ? connection.connectionType
        : (connection.connectionType === 'CUSTOMER' ? 'SUPPLIER' : 'CUSTOMER');

    if (type === 'SALE' && initiatorPerspectiveRole === 'SUPPLIER') {
      throw new BadRequestException('لا يمكن تسجيل حركة مبيعات في حساب مورد');
    }
    if (type === 'PURCHASE' && initiatorPerspectiveRole === 'CUSTOMER') {
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
    let balanceChange = new Decimal(0);

    let netImpactAmount = decimalAmount;
    if (orderId && (type === 'SALE' || type === 'PURCHASE')) {
      const linkedOrder = await tx.order.findUnique({
        where: { id: orderId },
      });
      if (linkedOrder) {
        if (linkedOrder.isCash) {
          netImpactAmount = new Decimal(0);
        } else if (decimalAmount.equals(new Decimal(linkedOrder.total as any || '0'))) {
          const paid = new Decimal(linkedOrder.paidAmount as any || '0');
          netImpactAmount = Decimal.max(0, decimalAmount.minus(paid));
        }
      }
    }

    const isSenderRequester = connection.requesterId === senderId;
    const isCustomer = (connection.connectionType || 'CUSTOMER').toUpperCase() === 'CUSTOMER';

    switch (type) {
      case 'SALE':
        // A Sale (credit invoice) increases buyer's debt / supplier's credit (+netImpactAmount). Cash invoice has netImpactAmount = 0 (+0).
        balanceChange = netImpactAmount;
        break;
      case 'PURCHASE':
        // A Purchase (credit purchase) increases buyer's debt / supplier's credit (+netImpactAmount). Cash purchase has netImpactAmount = 0 (+0).
        balanceChange = netImpactAmount;
        break;
      case 'PAYMENT':
        // Payment reduces balance (-amount)
        balanceChange = decimalAmount.negated();
        break;
      case 'ADJUSTMENT':
        if (params.note?.includes('افتتاحي') || params.note?.includes('تسوية')) {
          balanceChange = decimalAmount;
        } else {
          balanceChange = isSenderRequester ? decimalAmount : decimalAmount.negated();
        }
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
    const receiverId = account.connection?.receiverId;

    const transactions = await client.transaction.findMany({
      where: {
        OR: [
          { connectionId: account.connectionId },
          ...(receiverId
            ? [
                {
                  connectionId: null,
                  OR: [
                    { senderId: account.connection.requesterId, receiverId },
                    { senderId: receiverId, receiverId: account.connection.requesterId },
                  ],
                },
              ]
            : []),
        ],
      },
      include: { order: true },
      orderBy: { createdAt: 'asc' },
    });

    const isCustomer = (account.connection?.connectionType || 'CUSTOMER').toUpperCase() === 'CUSTOMER';
    let balance = new Decimal(0);
    let hasOpeningTxn = false;

    for (const t of transactions) {
      let amount = new Decimal(t.amount as any);

      if (t.order && (t.transactionType === 'SALE' || t.transactionType === 'PURCHASE')) {
        if (t.order.isCash) {
          amount = new Decimal(0);
        } else if (t.order.paidAmount) {
          const paid = new Decimal(t.order.paidAmount as any || '0');
          amount = Decimal.max(0, amount.minus(paid));
        }
      }

      switch (t.transactionType) {
        case 'SALE':
          balance = balance.plus(amount);
          break;
        case 'PURCHASE':
          balance = balance.plus(amount);
          break;
        case 'PAYMENT':
          balance = balance.minus(amount);
          break;
        case 'ADJUSTMENT':
          if (t.note?.includes('افتتاحي') || (t as any).type === 'OPENING_BALANCE') {
            hasOpeningTxn = true;
            balance = balance.plus(amount);
          } else {
            const isSenderRequester = t.senderId === account.connection.requesterId;
            balance = isSenderRequester ? balance.plus(amount) : balance.minus(amount);
          }
          break;
      }
    }

    // If there was no opening balance transaction in the ledger, add the canonical account.openingBalance
    if (!hasOpeningTxn) {
      const opBal = new Decimal(
        (account.openingBalance as any) ||
        (account.connection as any)?.pendingOpenBalance ||
        0
      );
      if (!opBal.isZero()) {
        balance = balance.plus(opBal);
      }
    }

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
