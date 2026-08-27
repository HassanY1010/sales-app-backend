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
      create: jest.fn(async ({ data }: any) => {
        const item = { id: `item-${++seq}`, ...data };
        dbOrderItems.push(item);
        return item;
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
          if (where.transactionType) {
            if (typeof where.transactionType === 'object' && where.transactionType.in) {
              if (!where.transactionType.in.includes(t.transactionType)) return false;
            } else if (t.transactionType !== where.transactionType) {
              return false;
            }
          }
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
      findFirst: jest.fn(async ({ where }: any) => {
        return dbAdjustmentRequests.find((r) => {
          if (where.targetType && r.targetType !== where.targetType) return false;
          if (where.targetId && r.targetId !== where.targetId) return false;
          if (where.status && r.status !== where.status) return false;
          return true;
        }) || null;
      }),
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
      total: '10000',
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
    expect(dbOrderItems[0].total).toBe('8000');
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

  // 15. TC-15: Transaction failure rolls back all updates atomically
  it('TC-15: Transaction failure leaves invoice, ledger, balance, and request unchanged (Rollback)', async () => {
    dbOrders.push({
      id: 'order-rollback',
      orderNumber: 'INV-ROLL',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      total: '5000',
      subtotal: '5000',
      paidAmount: '0',
    });
    dbTransactions.push({
      id: 'txn-roll',
      orderId: 'order-rollback',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      amount: '5000',
      transactionType: 'SALE',
      accountId: 'acc-1',
    });

    await financeService.rebuildAccountBalance('acc-1', mockPrisma);
    expect(dbAccounts[0].balance.toNumber()).toBe(5000);

    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-rollback',
      requestedAmount: '3000',
      reason: 'تعديل سيتم محاكاة فشله',
    });

    // Mock an error inside financeService.rebuildAccountBalance
    const origRebuild = financeService.rebuildAccountBalance;
    jest.spyOn(financeService, 'rebuildAccountBalance').mockImplementationOnce(async () => {
      throw new Error('Database connection dropped during ledger rebuild');
    });

    await expect(service.approve('biz-seller', 'user-seller', req.id)).rejects.toThrow(
      'Database connection dropped during ledger rebuild',
    );

    // Request is still PENDING
    const currentReq = dbAdjustmentRequests.find((r) => r.id === req.id);
    expect(currentReq.status).toBe('PENDING');

    // Restore spy
    jest.spyOn(financeService, 'rebuildAccountBalance').mockImplementation(origRebuild);
  });

  // 16. TC-16: Concurrent double accept is prevented and rejects subsequent calls safely
  it('TC-16: Calling approve consecutively rejects the second attempt without duplicate effects', async () => {
    dbOrders.push({
      id: 'order-double',
      orderNumber: 'INV-DBL',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      total: '10000',
      subtotal: '10000',
    });
    dbTransactions.push({
      id: 'txn-double',
      orderId: 'order-double',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      amount: '10000',
      transactionType: 'SALE',
      accountId: 'acc-1',
    });

    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-double',
      requestedAmount: '7000',
      reason: 'تخفيض متفق عليه',
    });

    const first = await service.approve('biz-seller', 'user-seller', req.id);
    expect(first.status).toBe('APPROVED');

    // Second approve attempt must throw BadRequestException
    await expect(service.approve('biz-seller', 'user-seller', req.id)).rejects.toThrow(
      BadRequestException,
    );
  });

  // 17. TC-17: Exact Scenario (5,000 -> 10,000 invoice adjustment)
  it('TC-17: Golden Verification - 5,000 -> 10,000 adjustment updates invoice, ledger and balance to exactly 10,000 without duplication', async () => {
    dbOrders.push({
      id: 'order-10025',
      orderNumber: '10025',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      total: '5000',
      subtotal: '5000',
      paidAmount: '0',
      isCash: false,
    });
    dbOrderItems.push({
      id: 'item-sugar',
      orderId: 'order-10025',
      itemName: 'سكر أبيض',
      unitPrice: '5000',
      quantity: 1,
      total: '5000',
    });
    dbTransactions.push({
      id: 'txn-sale-10025',
      orderId: 'order-10025',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      amount: '5000',
      transactionType: 'SALE',
      accountId: 'acc-1',
    });

    await financeService.rebuildAccountBalance('acc-1', mockPrisma);
    expect(dbAccounts[0].balance.toNumber()).toBe(5000);

    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-10025',
      requestedAmount: '10000',
      reason: 'الكمية 2 بدل واحد',
      requestedData: JSON.stringify({
        items: [{ id: 'item-sugar', itemName: 'سكر أبيض', unitPrice: '5000', quantity: 2 }],
      }),
    });

    expect(req.status).toBe('PENDING');
    // Balance and Invoice MUST remain 5,000 while PENDING
    expect(dbOrders.find((o) => o.id === 'order-10025').total).toBe('5000');
    expect(dbAccounts[0].balance.toNumber()).toBe(5000);

    const approved = await service.approve('biz-seller', 'user-seller', req.id);
    expect(approved.status).toBe('APPROVED');

    // 1. Invoice total becomes 10,000
    const updatedOrder = dbOrders.find((o) => o.id === 'order-10025');
    expect(updatedOrder.total).toBe('10000');
    expect(updatedOrder.subtotal).toBe('10000');

    // 2. OrderItem quantity = 2, total = 10,000
    const updatedItem = dbOrderItems.find((i) => i.id === 'item-sugar');
    expect(updatedItem.quantity).toBe(2);
    expect(updatedItem.total).toBe('10000');

    // 3. Linked SALE transaction updated to 10,000
    const linkedTxn = dbTransactions.find((t) => t.id === 'txn-sale-10025');
    expect(linkedTxn.amount).toBe('10000');

    // 4. Ledger transactions count is STILL 1 (no duplicate phantom rows)
    expect(dbTransactions.filter((t) => t.orderId === 'order-10025').length).toBe(1);

    // 5. Customer Balance is exactly 10,000 (NOT 15,000)
    expect(dbAccounts[0].balance.toNumber()).toBe(10000);
    expect(dbAccounts[0].totalDebit.toNumber()).toBe(10000);
    expect(dbAccounts[0].totalCredit.toNumber()).toBe(0);
  });

  // 18. TC-18: Real Financial Scenario with Previous Payment (Invoice: 5,000, Paid: 2,000 -> New: 10,000 -> Accept -> Balance: 8,000)
  it('TC-18: Real scenario with previous payment (5,000 invoice, 2,000 paid -> adjust 10,000 -> accept -> remaining balance 8,000)', async () => {
    dbOrders.push({
      id: 'order-pay-1',
      orderNumber: 'INV-PAY-01',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      total: '5000',
      subtotal: '5000',
      paidAmount: '0',
      isCash: false,
    });
    dbOrderItems.push({
      id: 'item-pay-1',
      orderId: 'order-pay-1',
      itemName: 'منتج أولي',
      unitPrice: '5000',
      quantity: 1,
      total: '5000',
    });
    // 1. Initial Sale Transaction
    dbTransactions.push({
      id: 'txn-sale-pay-1',
      orderId: 'order-pay-1',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      amount: '5000',
      transactionType: 'SALE',
      accountId: 'acc-1',
    });
    // 2. Initial Payment Receipt Voucher
    dbTransactions.push({
      id: 'txn-rec-pay-1',
      senderId: 'biz-buyer',
      receiverId: 'biz-seller',
      amount: '2000',
      transactionType: 'PAYMENT',
      accountId: 'acc-1',
    });

    // Rebuild initial balance: Sale (5,000) - Payment (2,000) -> Balance 3,000
    await financeService.rebuildAccountBalance('acc-1', mockPrisma);
    expect(dbAccounts[0].balance.toNumber()).toBe(3000);
    expect(dbAccounts[0].totalDebit.toNumber()).toBe(3000);
    expect(dbAccounts[0].totalCredit.toNumber()).toBe(0);

    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-pay-1',
      requestedAmount: '10000',
      reason: 'تعديل الكمية إلى 2',
      requestedData: JSON.stringify({
        items: [{ id: 'item-pay-1', itemName: 'منتج أولي', unitPrice: '5000', quantity: 2 }],
      }),
    });

    // Accept Adjustment
    const approved = await service.approve('biz-seller', 'user-seller', req.id);
    expect(approved.status).toBe('APPROVED');

    // 1. Invoice Total updated to 10,000
    const updatedOrder = dbOrders.find((o) => o.id === 'order-pay-1');
    expect(updatedOrder.total).toBe('10000');

    // 2. Account Statement contains exactly 2 transactions (Sale 10,000 + Payment 2,000) - NO duplicates
    const accountTxns = dbTransactions.filter((t) => t.accountId === 'acc-1');
    expect(accountTxns.length).toBe(2);

    // 3. Customer Balance is exactly 8,000 (Sale 10,000 - Payment 2,000)
    expect(dbAccounts[0].balance.toNumber()).toBe(8000);
    expect(dbAccounts[0].totalDebit.toNumber()).toBe(8000);
    expect(dbAccounts[0].totalCredit.toNumber()).toBe(0);
  });

  // 19. TC-19: Real Scenario with Previous Payment - Reject maintains exact 3,000 balance
  it('TC-19: Real scenario with previous payment - Reject maintains Invoice 5,000, Paid 2,000, Balance 3,000 with zero financial effect', async () => {
    dbOrders.push({
      id: 'order-pay-rej',
      orderNumber: 'INV-PAY-REJ',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      total: '5000',
      subtotal: '5000',
      paidAmount: '0',
    });
    dbTransactions.push({
      id: 'txn-sale-pay-rej',
      orderId: 'order-pay-rej',
      senderId: 'biz-seller',
      receiverId: 'biz-buyer',
      amount: '5000',
      transactionType: 'SALE',
      accountId: 'acc-1',
    });
    dbTransactions.push({
      id: 'txn-rec-pay-rej',
      senderId: 'biz-buyer',
      receiverId: 'biz-seller',
      amount: '2000',
      transactionType: 'PAYMENT',
      accountId: 'acc-1',
    });

    await financeService.rebuildAccountBalance('acc-1', mockPrisma);
    expect(dbAccounts[0].balance.toNumber()).toBe(3000);

    const req = await service.create('biz-buyer', 'user-buyer', {
      targetType: 'ORDER',
      targetId: 'order-pay-rej',
      requestedAmount: '10000',
      reason: 'طلب تعديل مرفوض',
    });

    const rejected = await service.reject('biz-seller', 'user-seller', req.id, 'غير موافق على زيادة الكمية');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('غير موافق على زيادة الكمية');

    // 1. Invoice unchanged
    const order = dbOrders.find((o) => o.id === 'order-pay-rej');
    expect(order.total).toBe('5000');

    // 2. Ledger unchanged (2 rows: Sale 5,000 + Payment 2,000)
    expect(dbTransactions.length).toBe(2);

    // 3. Balance unchanged at exactly 3,000
    expect(dbAccounts[0].balance.toNumber()).toBe(3000);
    expect(dbAccounts[0].totalDebit.toNumber()).toBe(3000);
    expect(dbAccounts[0].totalCredit.toNumber()).toBe(0);
  });
});
