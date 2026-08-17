import { Test, TestingModule } from '@nestjs/testing';
import { ConnectionsService } from './connections.service';
import { OrdersService } from '../orders/orders.service';
import { FinanceService } from '../finance/finance.service';
import { TransactionsService } from '../transactions/transactions.service';
import { PrismaService } from '../database/prisma.service';
import { InvoiceNumberService } from '../common/invoice-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import Decimal from 'decimal.js';

describe('Opening Balance Edit & Lifecycle Audit Spec', () => {
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
  const mockInvoiceNumberService = {
    generateInvoiceNumber: jest.fn().mockImplementation(async () => `INV-2026-${++seq}`),
    getNextInvoiceNumber: jest.fn().mockImplementation(async () => `INV-2026-${++seq}`),
  };

  const mockPrisma: any = {
    $transaction: jest.fn(async (cb) => cb(mockPrisma)),
    $executeRaw: jest.fn().mockResolvedValue(1),
    user: {
      findUnique: jest.fn(async ({ where }: any) => dbUsers.find((u) => u.id === where.id || (where.phoneNumber && u.phoneNumber === where.phoneNumber)) || null),
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
        const c = dbConnections.find((x) => x.id === where.id);
        if (c) Object.assign(c, data);
        return c;
      }),
    },
    account: {
      findUnique: jest.fn(async ({ where }: any) => {
        const acc = dbAccounts.find((a) => a.id === where.id || a.connectionId === where.connectionId);
        if (!acc) return null;
        const conn = dbConnections.find((c) => c.id === acc.connectionId);
        return { ...acc, connection: conn };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const acc = dbAccounts.find((a) => a.id === where.id);
        if (!acc) return null;
        if (data.balance?.increment !== undefined) {
          acc.balance = acc.balance.plus(new Decimal(data.balance.increment));
        } else if (data.balance !== undefined) {
          acc.balance = new Decimal(data.balance);
        }
        if (data.creditLimit !== undefined) acc.creditLimit = new Decimal(data.creditLimit);
        return acc;
      }),
    },
    transaction: {
      findUnique: jest.fn(async ({ where }: any) => dbTransactions.find((t) => t.id === where.id) || null),
      findFirst: jest.fn(async ({ where }: any) => {
        return dbTransactions.find((t) => {
          if (where.id && t.id === where.id) return true;
          if (where.transactionType && t.transactionType === where.transactionType) {
            if (where.note?.startsWith && t.note?.startsWith(where.note.startsWith)) return true;
            if (where.orderId && t.orderId === where.orderId) return true;
          }
          return false;
        }) || null;
      }),
      findMany: jest.fn(async () => {
        return dbTransactions.map((t) => ({ ...t, order: null }));
      }),
      create: jest.fn(async ({ data }: any) => {
        const newTxn = { id: `txn_${++seq}`, createdAt: new Date(), ...data };
        dbTransactions.push(newTxn);
        return newTxn;
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
    },
    auditLog: { create: jest.fn(async () => ({ id: 'audit-1' })) },
  };

  beforeEach(async () => {
    dbUsers = [
      { id: 'user-merchant', fullName: 'التاجر الرئيسي', phoneNumber: '777000111' },
      { id: 'user-customer', fullName: 'محلات الناصر', phoneNumber: '777222333' },
    ];
    dbBusinesses = [
      { id: 'biz-merchant', name: 'التاجر الرئيسي', userId: 'user-merchant', phoneNumber: '777000111' },
      { id: 'biz-customer', name: 'محلات الناصر', userId: 'user-customer', phoneNumber: '777222333' },
    ];
    dbConnections = [];
    dbAccounts = [];
    dbTransactions = [];
    seq = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionsService,
        OrdersService,
        FinanceService,
        TransactionsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: InvoiceNumberService, useValue: mockInvoiceNumberService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    connectionsService = module.get<ConnectionsService>(ConnectionsService);
    financeService = module.get<FinanceService>(FinanceService);
  });

  it('Test 1: Edit Opening Balance 10,000 -> 12,000', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 10000,
    });
    expect(dbAccounts[0].balance.toNumber()).toBe(10000);

    // Edit to 12,000
    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      openingBalance: 12000,
      creditLimit: 20000,
    });

    expect(dbAccounts[0].balance.toNumber()).toBe(12000);
    const adjustments = dbTransactions.filter((t) => t.note?.includes('افتتاحي'));
    expect(adjustments.length).toBe(1);
    expect(new Decimal(adjustments[0].amount).toNumber()).toBe(12000);
  });

  it('Test 2: Edit Opening Balance 12,000 -> 5,000 (Decrease)', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 12000,
    });
    expect(dbAccounts[0].balance.toNumber()).toBe(12000);

    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      openingBalance: 5000,
      creditLimit: 20000,
    });

    expect(dbAccounts[0].balance.toNumber()).toBe(5000);
    const adjustments = dbTransactions.filter((t) => t.note?.includes('افتتاحي'));
    expect(adjustments.length).toBe(1);
    expect(new Decimal(adjustments[0].amount).toNumber()).toBe(5000);
  });

  it('Test 3: Edit Opening Balance 5,000 -> 0 (Zero)', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 5000,
    });
    expect(dbAccounts[0].balance.toNumber()).toBe(5000);

    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      openingBalance: 0,
      creditLimit: 20000,
    });

    expect(dbAccounts[0].balance.toNumber()).toBe(0);
    const adjustments = dbTransactions.filter((t) => t.note?.includes('افتتاحي'));
    expect(adjustments.length).toBe(0); // Deleted cleanly when 0
  });

  it('Test 4: Edit Opening Balance 0 -> 10,000', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 0,
    });
    expect(dbAccounts[0].balance.toNumber()).toBe(0);

    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      openingBalance: 10000,
      creditLimit: 20000,
    });

    expect(dbAccounts[0].balance.toNumber()).toBe(10000);
    const adjustments = dbTransactions.filter((t) => t.note?.includes('افتتاحي'));
    expect(adjustments.length).toBe(1);
    expect(new Decimal(adjustments[0].amount).toNumber()).toBe(10000);
  });

  it('Test 5: Edit with Same Value 10,000 -> 10,000', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 10000,
    });

    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      openingBalance: 10000,
      creditLimit: 20000,
    });

    expect(dbAccounts[0].balance.toNumber()).toBe(10000);
    const adjustments = dbTransactions.filter((t) => t.note?.includes('افتتاحي'));
    expect(adjustments.length).toBe(1);
  });

  it('Test 6: Multiple Sequential Updates 10k -> 15k -> 7k -> 12k -> 3k', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 10000,
    });

    const values = [15000, 7000, 12000, 3000];
    for (const val of values) {
      await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
        openingBalance: val,
        creditLimit: 20000,
      });

      expect(dbAccounts[0].balance.toNumber()).toBe(val);
      const adjustments = dbTransactions.filter((t) => t.note?.includes('افتتاحي'));
      expect(adjustments.length).toBe(1);
      expect(new Decimal(adjustments[0].amount).toNumber()).toBe(val);
    }
  });

  it('Test 7: Receiver Perspective Customer Update (Customer was Requester)', async () => {
    // Simulate connection where Customer initiated the request to Merchant
    const conn = await mockPrisma.connection.create({
      data: {
        requesterId: 'biz-customer',
        receiverId: 'biz-merchant',
        connectionType: 'CUSTOMER',
        status: 'ACCEPTED',
        account: {
          create: {
            balance: '0',
            creditLimit: '20000',
          },
        },
      },
    });

    // Merchant updates terms with opening balance 11,000
    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      openingBalance: 11000,
      creditLimit: 20000,
    });

    // Verify balance is POSITIVE 11,000 (عليه / Debt), NEVER negative!
    expect(dbAccounts[0].balance.toNumber()).toBe(11000);
    expect(dbAccounts[0].balance.toNumber() > 0).toBe(true);
  });
});
