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

describe('FINAL HARD OPENING BALANCE VERIFICATION & AUDIT', () => {
  let connectionsService: ConnectionsService;
  let ordersService: OrdersService;
  let financeService: FinanceService;
  let transactionsService: TransactionsService;

  let dbUsers: any[] = [];
  let dbBusinesses: any[] = [];
  let dbConnections: any[] = [];
  let dbAccounts: any[] = [];
  let dbOrders: any[] = [];
  let dbOrderItems: any[] = [];
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
        if (data.totalCredit !== undefined) acc.totalCredit = new Decimal(data.totalCredit);
        if (data.totalDebit !== undefined) acc.totalDebit = new Decimal(data.totalDebit);
        if (data.creditLimit !== undefined) acc.creditLimit = new Decimal(data.creditLimit);
        return acc;
      }),
    },
    order: {
      findUnique: jest.fn(async ({ where }: any) => {
        const o = dbOrders.find((x) => (where.id && x.id === where.id) || (where.clientId && x.clientId === where.clientId));
        if (!o) return null;
        const items = dbOrderItems.filter((it) => it.orderId === o.id);
        return { ...o, items };
      }),
      create: jest.fn(async ({ data }: any) => {
        const id = `ord_${++seq}`;
        const newOrder = { id, ...data, items: [] };
        dbOrders.push(newOrder);
        if (data.items?.create) {
          for (const it of data.items.create) {
            const itemObj = { id: `item_${++seq}`, orderId: id, ...it };
            dbOrderItems.push(itemObj);
            newOrder.items.push(itemObj);
          }
        }
        return newOrder;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const o = dbOrders.find((x) => x.id === where.id);
        if (o) Object.assign(o, data);
        return o;
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
        return dbTransactions.map((t) => ({
          ...t,
          order: dbOrders.find((o) => o.id === t.orderId) || null,
        }));
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
    dbOrders = [];
    dbOrderItems = [];
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
    ordersService = module.get<OrdersService>(OrdersService);
    financeService = module.get<FinanceService>(FinanceService);
    transactionsService = module.get<TransactionsService>(TransactionsService);
  });

  it('Hard Check 1: 10,000 -> 12,000 -> 5,000 -> 0 -> 10,000 Exact Lifecycle', async () => {
    // 1. Initial 10,000
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 10000,
    });
    expect(dbAccounts[0].balance.toNumber()).toBe(10000);
    expect(dbTransactions.filter((t) => t.note?.includes('افتتاحي')).length).toBe(1);

    // 2. 10,000 -> 12,000
    await connectionsService.updateAccountTerms('biz-merchant', conn.id, { openingBalance: 12000 });
    expect(dbAccounts[0].balance.toNumber()).toBe(12000);
    expect(dbTransactions.filter((t) => t.note?.includes('افتتاحي')).length).toBe(1);

    // 3. 12,000 -> 5,000
    await connectionsService.updateAccountTerms('biz-merchant', conn.id, { openingBalance: 5000 });
    expect(dbAccounts[0].balance.toNumber()).toBe(5000);
    expect(dbTransactions.filter((t) => t.note?.includes('افتتاحي')).length).toBe(1);

    // 4. 5,000 -> 0
    await connectionsService.updateAccountTerms('biz-merchant', conn.id, { openingBalance: 0 });
    expect(dbAccounts[0].balance.toNumber()).toBe(0);
    expect(dbTransactions.filter((t) => t.note?.includes('افتتاحي')).length).toBe(0);

    // 5. 0 -> 10,000
    await connectionsService.updateAccountTerms('biz-merchant', conn.id, { openingBalance: 10000 });
    expect(dbAccounts[0].balance.toNumber()).toBe(10000);
    expect(dbTransactions.filter((t) => t.note?.includes('افتتاحي')).length).toBe(1);
  });

  it('Hard Check 2: Customer Requester vs Customer Receiver Direction Consistency', async () => {
    // Case A: Customer is Receiver (Merchant initiated)
    const connA = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'عميل أ',
      connectionType: 'CUSTOMER',
      openingBalance: 11000,
    });
    expect(dbAccounts[0].balance.toNumber()).toBe(11000);
    expect(dbAccounts[0].balance.toNumber() > 0).toBe(true);

    // Case B: Customer is Requester (Customer initiated request to Merchant)
    const connB = await mockPrisma.connection.create({
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

    await connectionsService.updateAccountTerms('biz-merchant', connB.id, { openingBalance: 11000 });
    const accB = dbAccounts.find((a) => a.connectionId === connB.id);
    expect(accB.balance.toNumber()).toBe(11000); // MUST be positive 11,000 (عليه), NEVER -11,000 (له)!
  });

  it('Hard Check 3: Opening Balance + Invoice + Payment + Subsequent Opening Balance Update', async () => {
    // 1. Initial Opening Balance = 10,000
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 10000,
    });
    expect(dbAccounts[0].balance.toNumber()).toBe(10000);

    // 2. Sales Invoice = 5,000
    await ordersService.createOrder('biz-merchant', {
      receiverId: 'biz-customer',
      connectionId: conn.id,
      accountRole: 'CUSTOMER',
      isCash: false,
      paidAmount: '0',
      items: [{ itemName: 'صنف 1', quantity: 1, unitPrice: '5000', unit: 'كرتون' }],
    } as any, 'business');

    // 3. Payment = 3,000
    await transactionsService.createTransaction('biz-merchant', {
      receiverId: 'biz-customer',
      amount: '3000',
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      connectionId: conn.id,
      note: 'سند قبض',
    } as any);

    // Expected: 10,000 + 5,000 - 3,000 = 12,000
    expect(dbAccounts[0].balance.toNumber()).toBe(12000);

    // 4. Update Opening Balance to 7,000
    await connectionsService.updateAccountTerms('biz-merchant', conn.id, { openingBalance: 7000 });

    // Expected: 7,000 + 5,000 - 3,000 = 9,000 (NOT 12,000 + 7,000 = 19,000!)
    expect(dbAccounts[0].balance.toNumber()).toBe(9000);

    // Verify exactly 1 Opening ADJUSTMENT transaction exists
    const openingTxns = dbTransactions.filter((t) => t.note?.includes('افتتاحي'));
    expect(openingTxns.length).toBe(1);
    expect(new Decimal(openingTxns[0].amount).toNumber()).toBe(7000);
  });
});
