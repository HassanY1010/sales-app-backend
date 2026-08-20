import { Test, TestingModule } from '@nestjs/testing';
import { ConnectionsService } from './connections.service';
import { FinanceService } from '../finance/finance.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import Decimal from 'decimal.js';

describe('Opening Balance vs Current Balance vs Credit Limit Separation Spec', () => {
  let connectionsService: ConnectionsService;
  let financeService: FinanceService;

  let dbUsers: any[] = [];
  let dbBusinesses: any[] = [];
  let dbConnections: any[] = [];
  let dbAccounts: any[] = [];
  let dbTransactions: any[] = [];
  let seq = 0;

  const mockEventsGateway = { emitToBusiness: jest.fn() };
  const mockNotificationsService = { sendPushNotification: jest.fn() };

  const mockPrisma: any = {
    $transaction: jest.fn(async (cb) => cb(mockPrisma)),
    $executeRaw: jest.fn().mockResolvedValue(1),
    user: {
      findUnique: jest.fn(async ({ where }: any) => dbUsers.find((u) => u.id === where.id || (where.phoneNumber && u.phoneNumber === where.phoneNumber)) || null),
      create: jest.fn(async ({ data }: any) => {
        const u = { id: `usr_${++seq}`, ...data };
        dbUsers.push(u);
        return u;
      }),
    },
    business: {
      findUnique: jest.fn(async ({ where }: any) => {
        const b = dbBusinesses.find((x) => x.id === where.id);
        if (!b) return null;
        return { ...b, user: dbUsers.find((u) => u.id === b.userId) };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const b = dbBusinesses.find((x) => where.phoneNumber && x.phoneNumber === where.phoneNumber);
        if (!b) return null;
        return { ...b, user: dbUsers.find((u) => u.id === b.userId) };
      }),
      create: jest.fn(async ({ data }: any) => {
        const b = { id: `biz_${++seq}`, ...data };
        dbBusinesses.push(b);
        return b;
      }),
    },
    connection: {
      findUnique: jest.fn(async ({ where }: any) => {
        const c = dbConnections.find((x) => x.id === where.id);
        if (!c) return null;
        const acc = dbAccounts.find((a) => a.connectionId === c.id);
        return { ...c, account: acc };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const c = dbConnections.find((x) => (where.id && x.id === where.id) || (where.requesterId && x.requesterId === where.requesterId && where.receiverId && x.receiverId === where.receiverId));
        if (!c) return null;
        const acc = dbAccounts.find((a) => a.connectionId === c.id);
        return { ...c, account: acc };
      }),
      create: jest.fn(async ({ data }: any) => {
        const id = `conn_${++seq}`;
        const newConn = { id, ...data, account: null };
        dbConnections.push(newConn);
        if (data.account?.create) {
          const accId = `acc_${++seq}`;
          const newAcc = {
            id: accId,
            connectionId: id,
            balance: new Decimal(data.account.create.balance || 0),
            openingBalance: new Decimal(data.account.create.openingBalance || 0),
            totalCredit: new Decimal(0),
            totalDebit: new Decimal(data.account.create.totalDebit || 0),
            creditLimit: new Decimal(data.account.create.creditLimit || 100000),
          };
          dbAccounts.push(newAcc);
          newConn.account = newAcc;
        }
        return newConn;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = dbConnections.findIndex((c) => c.id === where.id);
        if (idx !== -1) {
          dbConnections[idx] = { ...dbConnections[idx], ...data };
          return dbConnections[idx];
        }
        return null;
      }),
    },
    account: {
      findUnique: jest.fn(async ({ where }: any) => {
        const a = dbAccounts.find((x) => x.id === where.id || x.connectionId === where.connectionId);
        if (!a) return null;
        const conn = dbConnections.find((c) => c.id === a.connectionId);
        return { ...a, connection: conn };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = dbAccounts.findIndex((x) => x.id === where.id);
        if (idx !== -1) {
          const prev = dbAccounts[idx];
          let newBalance = prev.balance;
          if (data.balance) {
            if (data.balance.increment) {
              newBalance = newBalance.plus(new Decimal(data.balance.increment));
            } else if (data.balance.decrement) {
              newBalance = newBalance.minus(new Decimal(data.balance.decrement));
            } else {
              newBalance = new Decimal(data.balance);
            }
          }
          dbAccounts[idx] = {
            ...prev,
            ...data,
            balance: newBalance,
            openingBalance: data.openingBalance !== undefined ? new Decimal(data.openingBalance) : prev.openingBalance,
            creditLimit: data.creditLimit !== undefined ? new Decimal(data.creditLimit) : prev.creditLimit,
          };
          return dbAccounts[idx];
        }
        return null;
      }),
    },
    transaction: {
      findMany: jest.fn(async () => dbTransactions),
      findFirst: jest.fn(async ({ where }: any) => {
        return dbTransactions.find((t) => {
          if (where.transactionType && t.transactionType !== where.transactionType) return false;
          if (where.note?.startsWith && !t.note?.startsWith(where.note.startsWith)) return false;
          return true;
        }) || null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const t = { id: `txn_${++seq}`, ...data, amount: new Decimal(data.amount || 0) };
        dbTransactions.push(t);
        return t;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = dbTransactions.findIndex((t) => t.id === where.id);
        if (idx !== -1) {
          dbTransactions[idx] = { ...dbTransactions[idx], ...data, amount: new Decimal(data.amount) };
          return dbTransactions[idx];
        }
        return null;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const idx = dbTransactions.findIndex((t) => t.id === where.id);
        if (idx !== -1) dbTransactions.splice(idx, 1);
        return {};
      }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit_1' }),
    },
  };

  beforeEach(async () => {
    dbUsers = [
      { id: 'usr-100', phoneNumber: '777111111', fullName: 'Merchant' },
      { id: 'usr-200', phoneNumber: '777222222', fullName: 'Nasser Stores' },
    ];
    dbBusinesses = [
      { id: 'biz-merchant', userId: 'usr-100', name: 'Al-Baraka Trading', phoneNumber: '777111111' },
      { id: 'biz-nasser', userId: 'usr-200', name: 'Nasser Stores', phoneNumber: '777222222' },
    ];
    dbConnections = [];
    dbAccounts = [];
    dbTransactions = [];
    seq = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionsService,
        FinanceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventsGateway, useValue: mockEventsGateway },
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    }).compile();

    connectionsService = module.get<ConnectionsService>(ConnectionsService);
    financeService = module.get<FinanceService>(FinanceService);
  });

  it('Test 1: Opening Balance (5,000) and Credit Limit (50,000) created independently', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222222',
      name: 'محلات الناصر',
      openingBalance: 5000,
      creditLimit: 50000,
      connectionType: 'CUSTOMER',
    });

    expect(conn.openingBalance).toBe(5000);
    expect(conn.account.openingBalance).toBe(5000);
    expect(conn.account.creditLimit).toBe(50000);
    expect(conn.account.balance).toBe(5000);
  });

  it('Test 2: When an operational invoice of 2,000 is added, Current Balance becomes 7,000 while Opening Balance remains 5,000', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222222',
      name: 'محلات الناصر',
      openingBalance: 5000,
      creditLimit: 50000,
      connectionType: 'CUSTOMER',
    });

    await mockPrisma.transaction.create({
      data: {
        transactionType: 'SALE',
        amount: 2000,
        senderId: 'biz-merchant',
        receiverId: 'biz-nasser',
        connectionId: conn.id,
      },
    });

    await financeService.rebuildAccountBalance(conn.account.id, mockPrisma);

    const freshConn = (connectionsService as any).normalizeConnection(
      await mockPrisma.connection.findUnique({ where: { id: conn.id } }),
      'biz-merchant',
    );

    expect(freshConn.openingBalance).toBe(5000);
    expect(freshConn.account.openingBalance).toBe(5000);
    expect(freshConn.account.balance).toBe(7000);
    expect(freshConn.account.creditLimit).toBe(50000);
  });

  it('Test 3: Editing Credit Limit ONLY (50,000 -> 80,000) does NOT touch Opening Balance or Current Balance', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222222',
      name: 'محلات الناصر',
      openingBalance: 5000,
      creditLimit: 50000,
      connectionType: 'CUSTOMER',
    });

    await mockPrisma.transaction.create({
      data: {
        transactionType: 'SALE',
        amount: 2000,
        senderId: 'biz-merchant',
        receiverId: 'biz-nasser',
        connectionId: conn.id,
      },
    });
    await financeService.rebuildAccountBalance(conn.account.id, mockPrisma);

    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      creditLimit: 80000,
    });

    const freshConn = (connectionsService as any).normalizeConnection(
      await mockPrisma.connection.findUnique({ where: { id: conn.id } }),
      'biz-merchant',
    );

    expect(freshConn.openingBalance).toBe(5000);
    expect(freshConn.account.balance).toBe(7000);
    expect(freshConn.account.creditLimit).toBe(80000);
  });

  it('Test 4: Editing Opening Balance (5,000 -> 8,000) updates Current Balance to 10,000 without accumulating Credit Limit', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222222',
      name: 'محلات الناصر',
      openingBalance: 5000,
      creditLimit: 50000,
      connectionType: 'CUSTOMER',
    });

    await mockPrisma.transaction.create({
      data: {
        transactionType: 'SALE',
        amount: 2000,
        senderId: 'biz-merchant',
        receiverId: 'biz-nasser',
        connectionId: conn.id,
      },
    });
    await financeService.rebuildAccountBalance(conn.account.id, mockPrisma);

    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      openingBalance: 8000,
      creditLimit: 50000,
    });

    const freshConn = (connectionsService as any).normalizeConnection(
      await mockPrisma.connection.findUnique({ where: { id: conn.id } }),
      'biz-merchant',
    );

    expect(freshConn.openingBalance).toBe(8000);
    expect(freshConn.account.openingBalance).toBe(8000);
    expect(freshConn.account.balance).toBe(10000);
    expect(freshConn.account.creditLimit).toBe(50000);
  });

  it('Test 5: Editing Opening Balance for a second time (8,000 -> 12,000) updates Current Balance to 14,000 with ZERO accumulation', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222222',
      name: 'محلات الناصر',
      openingBalance: 5000,
      creditLimit: 50000,
      connectionType: 'CUSTOMER',
    });

    await mockPrisma.transaction.create({
      data: {
        transactionType: 'SALE',
        amount: 2000,
        senderId: 'biz-merchant',
        receiverId: 'biz-nasser',
        connectionId: conn.id,
      },
    });
    await financeService.rebuildAccountBalance(conn.account.id, mockPrisma);

    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      openingBalance: 8000,
      creditLimit: 50000,
    });

    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      openingBalance: 12000,
      creditLimit: 50000,
    });

    const freshConn = (connectionsService as any).normalizeConnection(
      await mockPrisma.connection.findUnique({ where: { id: conn.id } }),
      'biz-merchant',
    );

    expect(freshConn.openingBalance).toBe(12000);
    expect(freshConn.account.balance).toBe(14000);
    expect(freshConn.account.creditLimit).toBe(50000);
  });

  it('Test 6: Editing Opening Balance to 0 deletes opening adjustment and sets Current Balance to operational amount (2,000)', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222222',
      name: 'محلات الناصر',
      openingBalance: 5000,
      creditLimit: 50000,
      connectionType: 'CUSTOMER',
    });

    await mockPrisma.transaction.create({
      data: {
        transactionType: 'SALE',
        amount: 2000,
        senderId: 'biz-merchant',
        receiverId: 'biz-nasser',
        connectionId: conn.id,
      },
    });
    await financeService.rebuildAccountBalance(conn.account.id, mockPrisma);

    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      openingBalance: 0,
      creditLimit: 50000,
    });

    const freshConn = (connectionsService as any).normalizeConnection(
      await mockPrisma.connection.findUnique({ where: { id: conn.id } }),
      'biz-merchant',
    );

    expect(freshConn.openingBalance).toBe(0);
    expect(freshConn.account.balance).toBe(2000);
  });

  it('Test 7 (Legacy Data Check): Legacy Account with openingBalance=0/null resolves 5,000 from transaction or pendingOpenBalance without corruption', async () => {
    // Simulate legacy connection created before openingBalance column existed
    const legacyConn = await mockPrisma.connection.create({
      data: {
        requesterId: 'biz-merchant',
        receiverId: 'biz-nasser',
        status: 'ACCEPTED',
        connectionType: 'CUSTOMER',
        pendingOpenBalance: 5000,
        account: {
          create: {
            balance: 7000, // 5,000 opening + 2,000 invoice
            openingBalance: 0, // Legacy default 0
            creditLimit: 50000,
          },
        },
      },
    });

    const normalized = (connectionsService as any).normalizeConnection(
      await mockPrisma.connection.findUnique({ where: { id: legacyConn.id } }),
      'biz-merchant',
    );

    // Must resolve 5,000 from pendingOpenBalance / transaction instead of falling back to 0
    expect(normalized.openingBalance).toBe(5000);
    expect(normalized.account.openingBalance).toBe(5000);
    expect(normalized.account.balance).toBe(7000);
    expect(normalized.account.creditLimit).toBe(50000);
  });

  it('Test 8 (Multiple Adjustments & Transactions): Correctly identifies TRUE opening adjustment (5,000) when account has later adjustments (1,500)', async () => {
    const legacyConn = await mockPrisma.connection.create({
      data: {
        requesterId: 'biz-merchant',
        receiverId: 'biz-nasser',
        status: 'ACCEPTED',
        connectionType: 'CUSTOMER',
        account: {
          create: {
            balance: 8500, // 5,000 opening + 2,000 invoice + 1,500 later adjustment
            openingBalance: 0,
            creditLimit: 50000,
          },
        },
      },
    });

    // 1. Initial Opening Balance Adjustment (CreatedAt = T1)
    const t1 = await mockPrisma.transaction.create({
      data: {
        transactionType: 'ADJUSTMENT',
        amount: 5000,
        note: 'رصيد افتتاحي: 5000',
        connectionId: legacyConn.id,
        createdAt: new Date('2026-01-01T10:00:00Z'),
      },
    });

    // 2. Operational SALE transaction (CreatedAt = T2)
    const t2 = await mockPrisma.transaction.create({
      data: {
        transactionType: 'SALE',
        amount: 2000,
        connectionId: legacyConn.id,
        createdAt: new Date('2026-01-02T10:00:00Z'),
      },
    });

    // 3. Later regular Adjustment (CreatedAt = T3)
    const t3 = await mockPrisma.transaction.create({
      data: {
        transactionType: 'ADJUSTMENT',
        amount: 1500,
        note: 'تسوية فروقات جرد سنوي',
        connectionId: legacyConn.id,
        createdAt: new Date('2026-01-03T10:00:00Z'),
      },
    });

    const connWithTx = {
      ...(await mockPrisma.connection.findUnique({ where: { id: legacyConn.id } })),
      transactions: [t1, t2, t3],
    };

    const normalized = (connectionsService as any).normalizeConnection(connWithTx, 'biz-merchant');

    // Must resolve 5,000 (the genuine opening adjustment), NOT 1,500 (the later inventory adjustment)
    expect(normalized.openingBalance).toBe(5000);
    expect(normalized.account.openingBalance).toBe(5000);
    expect(normalized.account.balance).toBe(8500);
    expect(normalized.account.creditLimit).toBe(50000);
  });

  it('Test 9 (Backfill Idempotency): Running backfill multiple times maintains identical correct values with zero corruption', async () => {
    // 1. Setup account
    const legacyConn = await mockPrisma.connection.create({
      data: {
        requesterId: 'biz-merchant',
        receiverId: 'biz-nasser',
        status: 'ACCEPTED',
        connectionType: 'CUSTOMER',
        pendingOpenBalance: 5000,
        account: {
          create: {
            balance: 7000,
            openingBalance: 0,
            creditLimit: 50000,
          },
        },
      },
    });

    // Run 1: Normalize and update account terms
    const run1 = (connectionsService as any).normalizeConnection(
      await mockPrisma.connection.findUnique({ where: { id: legacyConn.id } }),
      'biz-merchant',
    );
    expect(run1.openingBalance).toBe(5000);
    expect(run1.account.balance).toBe(7000);

    // Persist openingBalance on account
    await mockPrisma.account.update({
      where: { id: legacyConn.account.id },
      data: { openingBalance: 5000 },
    });

    // Run 2: Re-read after backfill
    const run2 = (connectionsService as any).normalizeConnection(
      await mockPrisma.connection.findUnique({ where: { id: legacyConn.id } }),
      'biz-merchant',
    );
    expect(run2.openingBalance).toBe(5000);
    expect(run2.account.balance).toBe(7000);
    expect(run2.account.creditLimit).toBe(50000);

    // Run 3: Idempotent re-execution
    expect(run2).toEqual(run1);
  });
});