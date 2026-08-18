import { Test, TestingModule } from '@nestjs/testing';
import { TransactionsService } from './transactions.service';
import { FinanceService } from '../finance/finance.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { Decimal } from 'decimal.js';

describe('Dual-Role Receipt Voucher Routing & Connection Integrity Tests', () => {
  let transactionsService: TransactionsService;
  let financeService: FinanceService;

  const mockPrisma = {
    $transaction: jest.fn(async (cb) => cb(mockPrisma)),
    transaction: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    connection: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    account: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    business: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  };

  const mockNotificationsService = {
    sendPushNotification: jest.fn().mockResolvedValue(true),
  };

  const mockEventsGateway = {
    emitToBusiness: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        FinanceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    transactionsService = module.get<TransactionsService>(TransactionsService);
    financeService = module.get<FinanceService>(FinanceService);
  });

  const BIZ_A = 'biz-sanaa-grocery'; // بقالة صنعاء (User A)
  const BIZ_B = 'biz-nasser-stores';  // محلات الناصر (User B)

  // Connection 1: A treats B as CUSTOMER (requester: A, receiver: B, connectionType: CUSTOMER)
  const customerConnection = {
    id: 'conn-customer-111',
    requesterId: BIZ_A,
    receiverId: BIZ_B,
    connectionType: 'CUSTOMER',
    status: 'ACTIVE',
    account: {
      id: 'acc-cust-111',
      connectionId: 'conn-customer-111',
      balance: new Decimal('0'),
      totalDebit: new Decimal('0'),
      totalCredit: new Decimal('0'),
      currency: 'YER',
    },
  };

  // Connection 2: A treats B as SUPPLIER (requester: A, receiver: B, connectionType: SUPPLIER)
  const supplierConnection = {
    id: 'conn-supplier-222',
    requesterId: BIZ_A,
    receiverId: BIZ_B,
    connectionType: 'SUPPLIER',
    status: 'ACTIVE',
    account: {
      id: 'acc-supp-222',
      connectionId: 'conn-supplier-222',
      balance: new Decimal('0'),
      totalDebit: new Decimal('0'),
      totalCredit: new Decimal('0'),
      currency: 'YER',
    },
  };

  test('TEST 1: User A creates a Receipt Voucher for B as CUSTOMER when dual relationships exist', async () => {
    // Both connections exist in database
    const store = [customerConnection, supplierConnection];

    mockPrisma.connection.findFirst.mockImplementation(({ where }) => {
      if (where.id) {
        return store.find((c) => c.id === where.id);
      }
      if (where.OR) {
        for (const clause of where.OR) {
          const match = store.find(
            (c) =>
              c.requesterId === clause.requesterId &&
              c.receiverId === clause.receiverId &&
              (!clause.connectionType || c.connectionType === clause.connectionType),
          );
          if (match) return match;
        }
      }
      return null;
    });

    mockPrisma.account.update.mockImplementation(({ where, data }) => {
      const targetConn = store.find((c) => c.account.id === where.id);
      if (targetConn) {
        if (data.balance?.increment) {
          targetConn.account.balance = targetConn.account.balance.plus(new Decimal(data.balance.increment));
        }
        return targetConn.account;
      }
      return { id: where.id, balance: new Decimal('0') };
    });

    mockPrisma.transaction.create.mockImplementation(({ data }) => ({
      id: 'txn-receipt-1',
      ...data,
      sender: { id: data.senderId, name: 'محلات الناصر' },
      receiver: { id: data.receiverId, name: 'بقالة صنعاء' },
    }));

    const result = await transactionsService.createTransaction(BIZ_A, {
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      receiverId: BIZ_B,
      accountRole: 'CUSTOMER',
      amount: '5000',
      voucherNumber: 'REC-2026-001',
      note: 'سند قبض من محلات الناصر (عميل)',
    });

    // 1. Transaction must be linked strictly to the CUSTOMER connection
    expect(result.connectionId).toBe('conn-customer-111');
    expect(result.senderId).toBe(BIZ_B); // Funds sender (Customer)
    expect(result.receiverId).toBe(BIZ_A); // Funds receiver (Merchant)

    // 2. Account balance for customer connection must be updated
    expect(mockPrisma.account.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'acc-cust-111' },
      }),
    );
  });

  test('TEST 2: Order of Connections in DB must NOT affect role resolution (Deterministic Resolution)', async () => {
    // Reverse store order: SUPPLIER is returned first if no type filter is applied
    const store = [supplierConnection, customerConnection];

    mockPrisma.connection.findFirst.mockImplementation(({ where }) => {
      if (where.id) {
        return store.find((c) => c.id === where.id);
      }
      if (where.OR) {
        for (const clause of where.OR) {
          const match = store.find(
            (c) =>
              c.requesterId === clause.requesterId &&
              c.receiverId === clause.receiverId &&
              (!clause.connectionType || c.connectionType === clause.connectionType),
          );
          if (match) return match;
        }
      }
      return null;
    });

    mockPrisma.account.update.mockImplementation(({ where }) => {
      const targetConn = store.find((c) => c.account.id === where.id);
      return targetConn ? targetConn.account : { id: where.id, balance: new Decimal('0') };
    });

    mockPrisma.transaction.create.mockImplementation(({ data }) => ({
      id: 'txn-receipt-2',
      ...data,
    }));

    const result = await transactionsService.createTransaction(BIZ_A, {
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      receiverId: BIZ_B,
      accountRole: 'CUSTOMER',
      amount: '3000',
    });

    // Must still resolve strictly to CUSTOMER connection even when SUPPLIER connection is first
    expect(result.connectionId).toBe('conn-customer-111');
  });

  test('TEST 3: User A creates a Payment for B as SUPPLIER attaches to SUPPLIER connection', async () => {
    const store = [customerConnection, supplierConnection];

    mockPrisma.connection.findFirst.mockImplementation(({ where }) => {
      if (where.id) return store.find((c) => c.id === where.id);
      if (where.OR) {
        for (const clause of where.OR) {
          const match = store.find(
            (c) =>
              c.requesterId === clause.requesterId &&
              c.receiverId === clause.receiverId &&
              (!clause.connectionType || c.connectionType === clause.connectionType),
          );
          if (match) return match;
        }
      }
      return null;
    });

    mockPrisma.account.update.mockImplementation(({ where }) => {
      const targetConn = store.find((c) => c.account.id === where.id);
      return targetConn ? targetConn.account : { id: where.id, balance: new Decimal('0') };
    });

    mockPrisma.transaction.create.mockImplementation(({ data }) => ({
      id: 'txn-payment-supp',
      ...data,
    }));

    const result = await transactionsService.createTransaction(BIZ_A, {
      transactionType: 'PAYMENT',
      paymentDirection: 'PAID',
      receiverId: BIZ_B,
      accountRole: 'SUPPLIER',
      amount: '4000',
      voucherNumber: 'PAY-2026-001',
      note: 'سند صرف للمورد محلات الناصر',
    });

    expect(result.connectionId).toBe('conn-supplier-222');
    expect(result.senderId).toBe(BIZ_A); // Funds sender (Merchant paying supplier)
    expect(result.receiverId).toBe(BIZ_B); // Funds receiver (Supplier)
  });

  test('TEST 4: Idempotency with clientId avoids duplicate ledger entries and mutations', async () => {
    const existingTxn = {
      id: 'txn-existing-uuid',
      clientId: 'device-client-uuid-999',
      connectionId: 'conn-customer-111',
      amount: '5000',
      sender: { id: BIZ_B, name: 'محلات الناصر' },
      receiver: { id: BIZ_A, name: 'بقالة صنعاء' },
    };

    mockPrisma.transaction.findUnique.mockResolvedValue(existingTxn);

    const result = await transactionsService.createTransaction(BIZ_A, {
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      receiverId: BIZ_B,
      accountRole: 'CUSTOMER',
      amount: '5000',
      clientId: 'device-client-uuid-999',
    });

    expect(result.id).toBe('txn-existing-uuid');
    expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.account.update).not.toHaveBeenCalled();
  });
});