import { Test, TestingModule } from '@nestjs/testing';
import { ConnectionsService } from './connections.service';
import { FinanceService } from '../finance/finance.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import Decimal from 'decimal.js';

describe('10 Comprehensive QA Scenarios for Opening Balance & Concurrency', () => {
  let connectionsService: ConnectionsService;
  let financeService: FinanceService;

  let dbUsers: any[] = [];
  let dbBusinesses: any[] = [];
  let dbConnections: any[] = [];
  let dbAccounts: any[] = [];
  let dbTransactions: any[] = [];
  let dbOrders: any[] = [];
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
        const a = dbAccounts.find((x) => x.id === where.id);
        if (!a) return null;
        if (data.balance !== undefined) a.balance = new Decimal(data.balance);
        if (data.openingBalance !== undefined) a.openingBalance = new Decimal(data.openingBalance);
        if (data.totalCredit !== undefined) a.totalCredit = new Decimal(data.totalCredit);
        if (data.totalDebit !== undefined) a.totalDebit = new Decimal(data.totalDebit);
        if (data.creditLimit !== undefined) a.creditLimit = new Decimal(data.creditLimit);
        return a;
      }),
    },
    transaction: {
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        let res = dbTransactions.filter((t) => {
          if (where.connectionId && t.connectionId !== where.connectionId) return false;
          if (where.transactionType && t.transactionType !== where.transactionType) return false;
          if (where.note?.contains && (!t.note || !t.note.includes(where.note.contains))) return false;
          return true;
        });
        return res;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const all = await mockPrisma.transaction.findMany({ where });
        return all[0] || null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const t = { id: `txn_${++seq}`, ...data, createdAt: new Date() };
        dbTransactions.push(t);
        return t;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const t = dbTransactions.find((x) => x.id === where.id);
        if (t) Object.assign(t, data);
        return t;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const idx = dbTransactions.findIndex((x) => x.id === where.id);
        if (idx !== -1) dbTransactions.splice(idx, 1);
        return {};
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        if (where?.id?.in) {
          dbTransactions = dbTransactions.filter((x) => !where.id.in.includes(x.id));
        }
        return { count: 1 };
      }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  };

  beforeEach(async () => {
    dbUsers = [];
    dbBusinesses = [];
    dbConnections = [];
    dbAccounts = [];
    dbTransactions = [];
    dbOrders = [];
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

  it('SCENARIO 1: Opening Balance without transactions -> Count=1, Balance=5000', async () => {
    const conn = await connectionsService.manualAddConnection('biz-me', {
      phoneNumber: '777000001',
      name: 'Customer 1',
      connectionType: 'CUSTOMER',
      openingBalance: 5000,
    });

    const openingTxns = dbTransactions.filter(t => t.connectionId === conn.id && t.note?.includes('افتتاحي'));
    expect(openingTxns.length).toBe(1);
    expect(openingTxns[0].amount).toBe(5000);
    expect(openingTxns[0].connectionId).toBe(conn.id);

    const acc = dbAccounts.find(a => a.connectionId === conn.id);
    expect(acc.balance.toNumber()).toBe(5000);
  });

  it('SCENARIO 2: Editing Opening Balance from 5000 to 3000 -> Count=1, Canonical updated, Balance=3000', async () => {
    const conn = await connectionsService.manualAddConnection('biz-me', {
      phoneNumber: '777000002',
      name: 'Customer 2',
      connectionType: 'CUSTOMER',
      openingBalance: 5000,
    });

    await connectionsService.updateAccountTerms('biz-me', conn.id, { openingBalance: 3000 });

    const openingTxns = dbTransactions.filter(t => t.connectionId === conn.id && t.note?.includes('افتتاحي'));
    expect(openingTxns.length).toBe(1);
    expect(openingTxns[0].amount).toBe(3000);
    expect(openingTxns[0].note).toBe('رصيد افتتاحي: 3000');

    const acc = dbAccounts.find(a => a.connectionId === conn.id);
    expect(acc.balance.toNumber()).toBe(3000);
  });

  it('SCENARIO 3: Save without edit x5 -> Count=1, No mutation/duplication', async () => {
    const conn = await connectionsService.manualAddConnection('biz-me', {
      phoneNumber: '777000003',
      name: 'Customer 3',
      connectionType: 'CUSTOMER',
      openingBalance: 4000,
    });

    for (let i = 0; i < 5; i++) {
      await connectionsService.updateAccountTerms('biz-me', conn.id, { openingBalance: 4000 });
    }

    const openingTxns = dbTransactions.filter(t => t.connectionId === conn.id && t.note?.includes('افتتاحي'));
    expect(openingTxns.length).toBe(1);
    expect(openingTxns[0].amount).toBe(4000);

    const acc = dbAccounts.find(a => a.connectionId === conn.id);
    expect(acc.balance.toNumber()).toBe(4000);
  });

  it('SCENARIO 4: Edit Credit Limit only -> Count=1 (or 0 if zero opening), Balance unaffected', async () => {
    const conn = await connectionsService.manualAddConnection('biz-me', {
      phoneNumber: '777000004',
      name: 'Customer 4',
      connectionType: 'CUSTOMER',
      openingBalance: 5000,
      creditLimit: 10000,
    });

    await connectionsService.updateAccountTerms('biz-me', conn.id, { creditLimit: 25000 });

    const openingTxns = dbTransactions.filter(t => t.connectionId === conn.id && t.note?.includes('افتتاحي'));
    expect(openingTxns.length).toBe(1);
    expect(openingTxns[0].amount).toBe(5000);

    const acc = dbAccounts.find(a => a.connectionId === conn.id);
    expect(acc.balance.toNumber()).toBe(5000);
    expect(acc.creditLimit.toNumber()).toBe(25000);
  });

  it('SCENARIO 5: Opening Balance = 0 -> Count=0, Balance=0', async () => {
    const conn = await connectionsService.manualAddConnection('biz-me', {
      phoneNumber: '777000005',
      name: 'Customer 5',
      connectionType: 'CUSTOMER',
      openingBalance: 0,
    });

    const openingTxns = dbTransactions.filter(t => t.connectionId === conn.id && t.note?.includes('افتتاحي'));
    expect(openingTxns.length).toBe(0);

    const acc = dbAccounts.find(a => a.connectionId === conn.id);
    expect(acc.balance.toNumber()).toBe(0);
  });

  it('SCENARIO 6: Concurrent Save (Promise.all) -> Count=1, Canonical preserved', async () => {
    const conn = await connectionsService.manualAddConnection('biz-me', {
      phoneNumber: '777000006',
      name: 'Customer 6',
      connectionType: 'CUSTOMER',
      openingBalance: 5000,
    });

    // Simulate 3 concurrent saves with 3000
    await Promise.all([
      connectionsService.updateAccountTerms('biz-me', conn.id, { openingBalance: 3000 }),
      connectionsService.updateAccountTerms('biz-me', conn.id, { openingBalance: 3000 }),
      connectionsService.updateAccountTerms('biz-me', conn.id, { openingBalance: 3000 }),
    ]);

    const openingTxns = dbTransactions.filter(t => t.connectionId === conn.id && t.note?.includes('افتتاحي'));
    expect(openingTxns.length).toBe(1);
    expect(openingTxns[0].amount).toBe(3000);

    const acc = dbAccounts.find(a => a.connectionId === conn.id);
    expect(acc.balance.toNumber()).toBe(3000);
  });

  it('SCENARIO 7: Existing Legacy Duplicates resolved cleanly on updateAccountTerms', async () => {
    const conn = await connectionsService.manualAddConnection('biz-me', {
      phoneNumber: '777000007',
      name: 'Customer 7',
      connectionType: 'CUSTOMER',
      openingBalance: 5000,
    });

    // Inject a rogue duplicate into dbTransactions
    dbTransactions.push({
      id: 'rogue-dup-1',
      transactionType: 'ADJUSTMENT',
      amount: 5000,
      note: 'رصيد افتتاحي: 5000',
      connectionId: conn.id,
      createdAt: new Date(),
    });

    expect(dbTransactions.filter(t => t.connectionId === conn.id).length).toBe(2);

    // Call updateAccountTerms (even with same 5000)
    await connectionsService.updateAccountTerms('biz-me', conn.id, { openingBalance: 5000 });

    const openingTxns = dbTransactions.filter(t => t.connectionId === conn.id && t.note?.includes('افتتاحي'));
    expect(openingTxns.length).toBe(1);
    expect(openingTxns[0].amount).toBe(5000);

    const acc = dbAccounts.find(a => a.connectionId === conn.id);
    expect(acc.balance.toNumber()).toBe(5000);
  });
});
