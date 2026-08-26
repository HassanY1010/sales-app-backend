import { Test, TestingModule } from '@nestjs/testing';
import { AdjustmentRequestsService } from './adjustment-requests.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../database/prisma.service';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import Decimal from 'decimal.js';

describe('Adjustment Requests Receipt Voucher E2E Integration Audit', () => {
  let service: AdjustmentRequestsService;
  let financeService: FinanceService;

  let dbBusinesses: any[] = [];
  let dbConnections: any[] = [];
  let dbAccounts: any[] = [];
  let dbTransactions: any[] = [];
  let dbAdjustmentRequests: any[] = [];
  let dbAuditLogs: any[] = [];
  let seq = 0;

  const mockNotificationsService = {
    notifyBusiness: jest.fn().mockResolvedValue(true),
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
      findUnique: jest.fn(async ({ where }: any) => dbAccounts.find((a) => a.id === where.id) || null),
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
    transaction: {
      findUnique: jest.fn(async ({ where }: any) => dbTransactions.find((t) => t.id === where.id) || null),
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
      { id: 'biz-merchant', name: 'التاجر الرئيسي' },
      { id: 'biz-customer', name: 'محلات الناصر' },
    ];
    dbConnections = [
      {
        id: 'conn-1',
        requesterId: 'biz-merchant',
        receiverId: 'biz-customer',
        connectionType: 'CUSTOMER',
        status: 'ACCEPTED',
        account: { id: 'acc-1', balance: new Decimal(0), totalDebit: new Decimal(0), totalCredit: new Decimal(0) },
      },
    ];
    dbAccounts = [
      {
        id: 'acc-1',
        connectionId: 'conn-1',
        balance: new Decimal(0),
        totalDebit: new Decimal(0),
        totalCredit: new Decimal(0),
        connection: dbConnections[0],
      },
    ];
    dbTransactions = [];
    dbAdjustmentRequests = [];
    dbAuditLogs = [];
    seq = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdjustmentRequestsService,
        FinanceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: { emitToBusiness: jest.fn() } },
      ],
    }).compile();

    service = module.get<AdjustmentRequestsService>(AdjustmentRequestsService);
    financeService = module.get<FinanceService>(FinanceService);
  });

  it('Verification 1: Creates PENDING request without modifying original receipt', async () => {
    // 1. Initial State: Customer has debt of 5,000 and pays 1,000 via Receipt Voucher
    const receipt = await mockPrisma.transaction.create({
      data: {
        id: 'txn-receipt-1',
        voucherNumber: 'REC-2026-001',
        amount: '1000.00',
        transactionType: 'PAYMENT',
        paymentMethod: 'CASH',
        senderId: 'biz-customer',
        receiverId: 'biz-merchant',
        note: 'سند قبض نقدي',
        accountId: 'acc-1',
      },
    });

    // 2. Customer creates an Adjustment Request to change amount from 1,000 to 800
    const adjReq = await service.create('biz-customer', 'user-cust-1', {
      targetType: 'TRANSACTION',
      targetId: receipt.id,
      requestedAmount: '800',
      reason: 'تصحيح خطأ في قيمة السند المسدد',
      originalData: JSON.stringify({ amount: '1000.00', note: 'سند قبض نقدي' }),
      requestedData: JSON.stringify({ amount: '800', note: 'سند قبض نقدي معدل' }),
    });

    expect(adjReq.status).toBe('PENDING');
    expect(adjReq.targetId).toBe('txn-receipt-1');
    expect(adjReq.requestedAmount).toBe('800');

    // 3. CRITICAL INTEGRITY CHECK: Original Transaction in DB MUST remain 1,000
    const originalInDb = dbTransactions.find((t) => t.id === 'txn-receipt-1');
    expect(originalInDb.amount).toBe('1000.00'); // NOT 800!
  });

  it('Verification 2: Approving request updates original receipt and rebuilds balance cleanly', async () => {
    // 1. Setup: Sale of 5,000 + Receipt of 1,000
    await mockPrisma.transaction.create({
      data: {
        id: 'txn-sale-1',
        amount: '5000.00',
        transactionType: 'SALE',
        senderId: 'biz-merchant',
        receiverId: 'biz-customer',
        accountId: 'acc-1',
      },
    });
    await mockPrisma.transaction.create({
      data: {
        id: 'txn-receipt-1',
        voucherNumber: 'REC-2026-001',
        amount: '1000.00',
        transactionType: 'PAYMENT',
        senderId: 'biz-customer',
        receiverId: 'biz-merchant',
        accountId: 'acc-1',
      },
    });

    // Rebuild initial balance: 5,000 - 1,000 = 4,000
    await financeService.rebuildAccountBalance('acc-1', mockPrisma);
    expect(dbAccounts[0].balance.toNumber()).toBe(4000);

    // 2. Create Adjustment Request for Receipt (1,000 -> 800)
    const adjReq = await service.create('biz-customer', 'user-cust-1', {
      targetType: 'TRANSACTION',
      targetId: 'txn-receipt-1',
      requestedAmount: '800',
      reason: 'تصحيح المبلغ المسدد إلى 800',
      originalData: JSON.stringify({ amount: '1000.00' }),
      requestedData: JSON.stringify({ amount: '800' }),
    });

    // 3. Merchant Approves Request
    const approved = await service.approve('biz-merchant', 'user-merch-1', adjReq.id);
    expect(approved.status).toBe('APPROVED');

    // 4. Verify Original Receipt in DB is now 800
    const updatedReceipt = dbTransactions.find((t) => t.id === 'txn-receipt-1');
    expect(updatedReceipt.amount).toBe('800');

    // 5. Verify Account Balance is now 5,000 - 800 = 4,200 (No duplicates!)
    expect(dbAccounts[0].balance.toNumber()).toBe(4200);
    expect(dbAccounts[0].totalDebit.toNumber()).toBe(4200);
    expect(dbAccounts[0].totalCredit.toNumber()).toBe(0);
  });

  it('Verification 3: Rejecting request leaves original receipt completely untouched', async () => {
    await mockPrisma.transaction.create({
      data: {
        id: 'txn-receipt-1',
        voucherNumber: 'REC-2026-001',
        amount: '1000.00',
        transactionType: 'PAYMENT',
        senderId: 'biz-customer',
        receiverId: 'biz-merchant',
        accountId: 'acc-1',
      },
    });

    const adjReq = await service.create('biz-customer', 'user-cust-1', {
      targetType: 'TRANSACTION',
      targetId: 'txn-receipt-1',
      requestedAmount: '500',
      reason: 'طلب تخفيض مرفوض',
    });

    const rejected = await service.reject('biz-merchant', 'user-merch-1', adjReq.id, 'المبلغ غير مطابق للكشف البنكي');

    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('المبلغ غير مطابق للكشف البنكي');

    // Receipt MUST remain 1,000.00
    const receiptInDb = dbTransactions.find((t) => t.id === 'txn-receipt-1');
    expect(receiptInDb.amount).toBe('1000.00');
  });

  it('Verification 4: Rejects non-existent targetId with NotFoundException', async () => {
    await expect(
      service.create('biz-customer', 'user-cust-1', {
        targetType: 'TRANSACTION',
        targetId: 'invalid-non-existent-id',
        requestedAmount: '500',
        reason: 'سبب التعديل',
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
