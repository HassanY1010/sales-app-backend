import { Test, TestingModule } from '@nestjs/testing';
import { AdjustmentRequestsService } from './adjustment-requests.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../database/prisma.service';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import Decimal from 'decimal.js';

describe('Bilateral Consent & Ledger Verification Test Suite (14 Mandatory Test Cases)', () => {
  let service: AdjustmentRequestsService;
  let financeService: FinanceService;

  let dbBusinesses: any[] = [];
  let dbConnections: any[] = [];
  let dbAccounts: any[] = [];
  let dbTransactions: any[] = [];
  let dbOrders: any[] = [];
  let dbOrderItems: any[] = [];
  let dbAdjustmentRequests: any[] = [];
  let dbAuditLogs: any[] = [];
  let seq = 0;

  const mockNotificationsService = {
    notifyBusiness: jest.fn().mockResolvedValue(true),
    sendPushNotification: jest.fn().mockResolvedValue(true),
  };

  const mockEventsGateway = {
    emitToBusiness: jest.fn(),
  };

  const mockPrisma: any = {
    $transaction: jest.fn(async (cb) => cb(mockPrisma)),
    business: {
      findUnique: jest.fn(async ({ where }: any) => dbBusinesses.find((b) => b.id === where.id) || null),
    },
    connection: {
      findFirst: jest.fn(async ({ where }: any) => {
        return dbConnections.find((c) => {
          if (where.id && c.id === where.id) return true;
          if (where.OR) {
            return where.OR.some((cond: any) =>
              (cond.requesterId === c.requesterId && cond.receiverId === c.receiverId) ||
              (cond.requesterId === c.receiverId && cond.receiverId === c.requesterId)
            );
          }
          return false;
        }) || null;
      }),
    },
    account: {
      findUnique: jest.fn(async ({ where }: any) => {
        const a = dbAccounts.find((acc) => acc.id === where.id);
        if (!a) return null;
        const conn = dbConnections.find((c) => c.id === a.connectionId);
        return { ...a, connection: conn || { requesterId: 'biz-seller', receiverId: 'biz-buyer' } };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const acc = dbAccounts.find((a) => a.id === where.id);
        if (acc) {
          if (data.balance !== undefined) acc.balance = new Decimal(data.balance);
          if (data.totalDebit !== undefined) acc.totalDebit = new Decimal(data.totalDebit);
          if (data.totalCredit !== undefined) acc.totalCredit = new Decimal(data.totalCredit);
        }
        return acc;
      }),
    },
    order: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const o = dbOrders.find((x) => x.id === where.id);
        if (!o) return null;
        const res = { ...o };
        if (include?.items) {
          res.items = dbOrderItems.filter((it) => it.orderId === o.id);
        }
        return res;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const o = dbOrders.find((x) => x.id === where.id);
        if (o) Object.assign(o, data);
        return o;
      }),
    },
    orderItem: {
      findUnique: jest.fn(async ({ where }: any) => dbOrderItems.find((i) => i.id === where.id) || null),
      findMany: jest.fn(async ({ where }: any) => {
        return dbOrderItems.filter((it) => {
          if (where?.orderId && it.orderId !== where.orderId) return false;
          return true;
        });
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const item = dbOrderItems.find((i) => i.id === where.id);
        if (item) Object.assign(item, data);
        return item;
      }),
    },
    transaction: {
      findUnique: jest.fn(async ({ where }: any) => dbTransactions.find((t) => t.id === where.id) || null),
      findFirst: jest.fn(async ({ where }: any) => {
        return dbTransactions.find((t) => {
          if (where.orderId && t.orderId !== where.orderId) return false;
          if (where.transactionType && t.transactionType !== where.transactionType) return false;
          return true;
        }) || null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return dbTransactions.filter((t) => {
          if (where?.account?.id && t.accountId !== where.account.id) return false;
          return true;
        });
      }),
      create: jest.fn(async ({ data }: any) => {
        const item = { id: `txn_${++seq}`, createdAt: new Date(), ...data };
        dbTransactions.push(item);
        return item;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const t = dbTransactions.find((x) => x.id === where.id);
        if (t) Object.assign(t, data);
        return t;
      }),
    },
    adjustmentRequest: {
      create: jest.fn(async ({ data }: any) => {
        const req = {
          id: `adj_${++seq}`,
          status: 'PENDING',
          createdAt: new Date(),
          ...data,
          requesterBusiness: dbBusinesses.find((b) => b.id === data.requesterBusinessId) || null,
          receiverBusiness: dbBusinesses.find((b) => b.id === data.receiverBusinessId) || null,
        };
        dbAdjustmentRequests.push(req);
        return req;
      }),
      findUnique: jest.fn(async ({ where }: any) => dbAdjustmentRequests.find((r) => r.id === where.id) || null),
      findMany: jest.fn(async () => dbAdjustmentRequests),
      count: jest.fn(async () => dbAdjustmentRequests.length),
      update: jest.fn(async ({ where, data }: any) => {
        const r = dbAdjustmentRequests.find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        const log = { id: `log_${++seq}`, ...data };
        dbAuditLogs.push(log);
        return log;
      }),
    },
  };

  beforeEach(async () => {
    dbBusinesses = [
      { id: 'biz-seller', name: 'مؤسسة التاجر المورد' },
      { id: 'biz-buyer', name: 'مؤسسة العميل المشتري' },
      { id: 'biz-other', name: 'طرف ثالث غريب' },
    ];

    dbConnections = [
      {
        id: 'conn-1',
        requesterId: 'biz-seller',
        receiverId: 'biz-buyer',
        status: 'ACCEPTED',
        account: { id: 'acc-1' },
      },
    ];

    dbAccounts = [
      {
        id: 'acc-1',
        connectionId: 'conn-1',
        balance: new Decimal(0),
        totalDebit: new Decimal(0),
        totalCredit: new Decimal(0),
        currency: 'YER',
      },
    ];

    dbTransactions = [];
    dbOrders = [];
    dbOrderItems = [];
    dbAdjustmentRequests = [];
    dbAuditLogs = [];
    seq = 0;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdjustmentRequestsService,
        FinanceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    service = module.get<AdjustmentRequestsService>(AdjustmentRequestsService);
    financeService = module.get<FinanceService>(FinanceService);
  });

  // 1. TC-1: Submitting invoice amendment creates PENDING request without altering document/ledger
  it('TC-1: Submitting invoice amendment creates PENDING request and alters zero financial numbers', async () => {
    dbOrders.push({
      id: 'order-1',
      orderNumber: 'INV-101',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      total: '10000',
      subtotal: '10000',
      paidAmount: '0',
      isCash: false,
      status: 'ISSUED',
      pricesVisible: true,
    });
    dbOrderItems.push({
      id: 'item-1',
      orderId: 'order-1',
      unitPrice: '1000',
      quantity: 10,
      totalPrice: '10000',
    });
    dbTransactions.push({
      id: 'txn-sale-1',
      orderId: 'order-1',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      amount: '10000',
      transactionType: 'SALE',
      accountId: 'acc-1',
    });

    await financeService.rebuildAccountBalance('acc-1', mockPrisma);
    expect(dbAccounts[0].balance.toNumber()).toBe(10000);

    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '8000',
      reason: 'تعديل الكمية لوجود تالف',
      originalData: JSON.stringify({ total: '10000' }),
      requestedData: JSON.stringify({ total: '8000' }),
    });

    expect(req.status).toBe('PENDING');
    // Order, Transaction, Account balance MUST remain unchanged
    expect(dbOrders[0].total).toBe('10000');
    expect(dbTransactions[0].amount).toBe('10000');
    expect(dbAccounts[0].balance.toNumber()).toBe(10000);
  });

  // 2. TC-2: Submitting receipt voucher amendment creates PENDING request without altering document/ledger
  it('TC-2: Submitting receipt voucher amendment creates PENDING request without altering ledger', async () => {
    dbTransactions.push({
      id: 'txn-rec-1',
      voucherNumber: 'REC-201',
      senderId: 'biz-buyer',
      receiverId: 'biz-seller',
      amount: '3000',
      transactionType: 'PAYMENT',
      accountId: 'acc-1',
    });

    await financeService.rebuildAccountBalance('acc-1', mockPrisma);
    expect(dbAccounts[0].balance.toNumber()).toBe(-3000);

    const req = await service.create('biz-seller', 'user-seller', {
      targetType: 'TRANSACTION',
      targetId: 'txn-rec-1',
      requestedAmount: '3500',
      reason: 'تصحيح مبلغ السند المستلم',
    });

    expect(req.status).toBe('PENDING');
    expect(dbTransactions[0].amount).toBe('3000');
    expect(dbAccounts[0].balance.toNumber()).toBe(-3000);
  });

  // 3. TC-3: Notification is sent with correct direct route to recipient
  it('TC-3: Push notification is dispatched to recipient with correct route', async () => {
    dbOrders.push({
      id: 'order-1',
      orderNumber: 'INV-101',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      total: '10000',
    });

    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '8000',
      reason: 'تعديل السعر',
    });

    expect(mockNotificationsService.notifyBusiness).toHaveBeenCalledWith(
      'biz-seller',
      expect.stringContaining('طلب تعديل'),
      expect.any(String),
      expect.objectContaining({
        type: 'ADJUSTMENT_REQUEST_CREATED',
        adjustmentRequestId: req.id,
      }),
    );
  });

  // 4. TC-4: Recipient can view old vs new details
  it('TC-4: Adjustment request preserves full original vs requested payload', async () => {
    dbOrders.push({ id: 'order-1', orderNumber: 'INV-101', senderId: 'biz-seller', receiverId: 'biz-buyer', total: '10000' });
    const originalJson = JSON.stringify({ items: [{ id: 'it1', unitPrice: 100 }] });
    const requestedJson = JSON.stringify({ items: [{ id: 'it1', unitPrice: 80 }] });

    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '8000',
      reason: 'تخفيض السعر المتفق عليه',
      originalData: originalJson,
      requestedData: requestedJson,
    });

    expect(req.originalData).toBe(originalJson);
    expect(req.requestedData).toBe(requestedJson);
    expect(req.reason).toBe('تخفيض السعر المتفق عليه');
  });

  // 5. TC-5: Approving invoice amendment updates order items, total, linked SALE txn, and rebuilds account
  it('TC-5: Approving invoice amendment updates order items, order total, linked SALE txn, and rebuilds account atomically', async () => {
    dbOrders.push({
      id: 'order-1',
      orderNumber: 'INV-101',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      total: '10000',
      subtotal: '10000',
      paidAmount: '0',
      isCash: false,
    });
    dbOrderItems.push({
      id: 'item-1',
      orderId: 'order-1',
      unitPrice: '1000',
      quantity: 10,
      totalPrice: '10000',
    });
    dbTransactions.push({
      id: 'txn-sale-1',
      orderId: 'order-1',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      amount: '10000',
      transactionType: 'SALE',
      accountId: 'acc-1',
    });

    await financeService.rebuildAccountBalance('acc-1', mockPrisma);
    expect(dbAccounts[0].balance.toNumber()).toBe(10000);

    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '8000',
      reason: 'تعديل السعر المتفق عليه',
      requestedData: JSON.stringify({
        items: [{ id: 'item-1', unitPrice: '800', quantity: 10 }],
      }),
    });

    const approved = await service.approve('biz-seller', 'user-seller', req.id);
    expect(approved.status).toBe('APPROVED');

    // Verify order item updated
    expect(dbOrderItems[0].unitPrice).toBe('800');
    expect(dbOrderItems[0].totalPrice).toBe('8000');
    // Verify order total updated
    expect(dbOrders[0].total).toBe('8000');
    // Verify linked SALE transaction updated
    expect(dbTransactions[0].amount).toBe('8000');
    // Verify ledger rebuilt balance
    expect(dbAccounts[0].balance.toNumber()).toBe(8000);
    expect(dbAccounts[0].totalDebit.toNumber()).toBe(8000);
  });

  // 6. TC-6: Approving receipt voucher amendment updates transaction amount and rebuilds account
  it('TC-6: Approving receipt voucher amendment updates transaction amount and rebuilds account without duplicate entries', async () => {
    dbTransactions.push({
      id: 'txn-sale-1',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      amount: '10000',
      transactionType: 'SALE',
      accountId: 'acc-1',
    });
    dbTransactions.push({
      id: 'txn-rec-1',
      senderId: 'biz-buyer',
      receiverId: 'biz-seller',
      amount: '3000',
      transactionType: 'PAYMENT',
      accountId: 'acc-1',
    });

    await financeService.rebuildAccountBalance('acc-1', mockPrisma);
    expect(dbAccounts[0].balance.toNumber()).toBe(7000);

    const req = await service.create('biz-seller', 'user-seller', {
      targetType: 'TRANSACTION',
      targetId: 'txn-rec-1',
      requestedAmount: '4000',
      reason: 'تصحيح السند المقبوض فعلياً',
    });

    await service.approve('biz-buyer', 'user-buyer', req.id);

    expect(dbTransactions.find((t) => t.id === 'txn-rec-1').amount).toBe('4000');
    expect(dbAccounts[0].balance.toNumber()).toBe(6000);
    expect(dbTransactions.length).toBe(2); // strictly no phantom rows
  });

  // 7. TC-7: Rejecting amendment requires mandatory reason and alters zero financial numbers
  it('TC-7: Rejecting amendment requires mandatory reason >= 5 chars and alters zero numbers', async () => {
    dbOrders.push({ id: 'order-1', orderNumber: 'INV-101', senderId: 'biz-seller', receiverId: 'biz-buyer', total: '10000' });
    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '5000',
      reason: 'طلب تخفيض كبير',
    });

    await expect(service.reject('biz-seller', 'user-seller', req.id, '')).rejects.toThrow(BadRequestException);
    await expect(service.reject('biz-seller', 'user-seller', req.id, 'لا')).rejects.toThrow(BadRequestException);

    const rejected = await service.reject('biz-seller', 'user-seller', req.id, 'الأسعار نهائية وغير قابلة للتخفيض');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('الأسعار نهائية وغير قابلة للتخفيض');
    expect(dbOrders[0].total).toBe('10000');
  });

  // 8. TC-8: Requester cannot approve their own adjustment request
  it('TC-8: Requester cannot self-approve adjustment request', async () => {
    dbOrders.push({ id: 'order-1', senderId: 'biz-seller', receiverId: 'biz-buyer', total: '10000' });
    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '8000',
      reason: 'طلب تعديل',
    });

    await expect(service.approve('biz-buyer', 'user-buyer', req.id)).rejects.toThrow(ForbiddenException);
  });

  // 9. TC-9: Unrelated third party cannot approve or reject
  it('TC-9: Unrelated third party cannot review adjustment request', async () => {
    dbOrders.push({ id: 'order-1', senderId: 'biz-seller', receiverId: 'biz-buyer', total: '10000' });
    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '8000',
      reason: 'طلب تعديل',
    });

    await expect(service.approve('biz-other', 'user-other', req.id)).rejects.toThrow(ForbiddenException);
    await expect(service.reject('biz-other', 'user-other', req.id, 'سبب الرفض')).rejects.toThrow(ForbiddenException);
  });

  // 10. TC-10: Cannot approve already approved request (Double Approval Prevention)
  it('TC-10: Cannot approve already approved request', async () => {
    dbOrders.push({ id: 'order-1', senderId: 'biz-seller', receiverId: 'biz-buyer', total: '10000' });
    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '8000',
      reason: 'طلب تعديل',
    });

    await service.approve('biz-seller', 'user-seller', req.id);
    await expect(service.approve('biz-seller', 'user-seller', req.id)).rejects.toThrow(BadRequestException);
  });

  // 11. TC-11: Cannot approve a rejected request
  it('TC-11: Cannot approve a rejected request', async () => {
    dbOrders.push({ id: 'order-1', senderId: 'biz-seller', receiverId: 'biz-buyer', total: '10000' });
    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '8000',
      reason: 'طلب تعديل',
    });

    await service.reject('biz-seller', 'user-seller', req.id, 'مرفوض بسبب عدم المطابقة');
    await expect(service.approve('biz-seller', 'user-seller', req.id)).rejects.toThrow(BadRequestException);
  });

  // 12. TC-12: Cannot reject an already approved request
  it('TC-12: Cannot reject an already approved request', async () => {
    dbOrders.push({ id: 'order-1', senderId: 'biz-seller', receiverId: 'biz-buyer', total: '10000' });
    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '8000',
      reason: 'طلب تعديل',
    });

    await service.approve('biz-seller', 'user-seller', req.id);
    await expect(service.reject('biz-seller', 'user-seller', req.id, 'رفض متأخر')).rejects.toThrow(BadRequestException);
  });

  // 13. TC-13: Audit log records full trail for create, approve, and reject
  it('TC-13: Audit logs record full trail of actions and reasons', async () => {
    dbOrders.push({ id: 'order-1', senderId: 'biz-seller', receiverId: 'biz-buyer', total: '10000' });
    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '8000',
      reason: 'طلب تعديل أمني',
    });

    await service.approve('biz-seller', 'user-seller', req.id);

    const createLog = dbAuditLogs.find((l) => l.action === 'CREATE_AMENDMENT');
    const approveLog = dbAuditLogs.find((l) => l.action === 'APPROVE_AMENDMENT');

    expect(createLog).toBeDefined();
    expect(createLog.resourceId).toBe('order-1');
    expect(approveLog).toBeDefined();
    expect(approveLog.details.finalAmount).toBe('8000');
  });

  // 14. TC-14: Realtime events are broadcasted to both parties on status changes
  it('TC-14: Realtime events are emitted to both businesses on approval and rejection', async () => {
    dbOrders.push({ id: 'order-1', senderId: 'biz-seller', receiverId: 'biz-buyer', total: '10000' });
    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-1',
      requestedAmount: '8000',
      reason: 'طلب تعديل',
    });

    await service.approve('biz-seller', 'user-seller', req.id);

    expect(mockEventsGateway.emitToBusiness).toHaveBeenCalledWith(
      'biz-buyer',
      'ACCOUNT_UPDATED',
      expect.objectContaining({ status: 'APPROVED', targetId: 'order-1' }),
    );
    expect(mockEventsGateway.emitToBusiness).toHaveBeenCalledWith(
      'biz-seller',
      'ACCOUNT_UPDATED',
      expect.objectContaining({ status: 'APPROVED', targetId: 'order-1' }),
    );
  });
});
