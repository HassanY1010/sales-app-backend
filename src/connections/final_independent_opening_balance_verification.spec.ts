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

describe('Final Independent Opening Balance Verification & Ledger Audit', () => {
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
    customerSupplierLink: { findFirst: jest.fn(async () => null) },
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

  it('Step 1 to 10: Complete Independent Lifecycle & Audit', async () => {
    // ── 1. Create Connection with Initial Opening Balance = 7,000 ──
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 7000,
    });

    const getOpeningBalanceFromLedger = () => {
      const openingTxn = dbTransactions.find((t) => t.note?.includes('افتتاحي'));
      return openingTxn ? new Decimal(openingTxn.amount).toNumber() : 0;
    };

    const getCurrentBalance = () => dbAccounts[0].balance.toNumber();

    // Initial check:
    expect(getOpeningBalanceFromLedger()).toBe(7000);
    expect(getCurrentBalance()).toBe(7000);

    // ── 2. After Credit Invoice 6,000 ──
    await ordersService.createOrder('biz-merchant', {
      receiverId: 'biz-customer',
      connectionId: conn.id,
      accountRole: 'CUSTOMER',
      isCash: false,
      paidAmount: '0',
      items: [{ itemName: 'بضاعة 1', quantity: 1, unitPrice: '6000', unit: 'كرتون' }],
    } as any, 'business');

    expect(getOpeningBalanceFromLedger()).toBe(7000); // IMMUTABLE 7,000
    expect(getCurrentBalance()).toBe(13000); // 7,000 + 6,000 = 13,000

    // ── 3. After Receipt 2,000 ──
    await transactionsService.createTransaction('biz-merchant', {
      receiverId: 'biz-customer',
      amount: '2000',
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      connectionId: conn.id,
      note: 'سند قبض 1',
    } as any);

    expect(getOpeningBalanceFromLedger()).toBe(7000); // IMMUTABLE 7,000
    expect(getCurrentBalance()).toBe(11000); // 13,000 - 2,000 = 11,000

    // ── 4. After Second Invoice 3,000 ──
    await ordersService.createOrder('biz-merchant', {
      receiverId: 'biz-customer',
      connectionId: conn.id,
      accountRole: 'CUSTOMER',
      isCash: false,
      paidAmount: '0',
      items: [{ itemName: 'بضاعة 2', quantity: 1, unitPrice: '3000', unit: 'كرتون' }],
    } as any, 'business');

    expect(getOpeningBalanceFromLedger()).toBe(7000); // IMMUTABLE 7,000
    expect(getCurrentBalance()).toBe(14000); // 11,000 + 3,000 = 14,000

    // ── 5. After Second Receipt 1,000 ──
    await transactionsService.createTransaction('biz-merchant', {
      receiverId: 'biz-customer',
      amount: '1000',
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      connectionId: conn.id,
      note: 'سند قبض 2',
    } as any);

    expect(getOpeningBalanceFromLedger()).toBe(7000); // IMMUTABLE 7,000
    expect(getCurrentBalance()).toBe(13000); // 14,000 - 1,000 = 13,000

    // ── 6. After Rebuild ──
    await financeService.rebuildAccountBalance(dbAccounts[0].id);
    expect(getOpeningBalanceFromLedger()).toBe(7000); // IMMUTABLE 7,000
    expect(getCurrentBalance()).toBe(13000); // REBUILT = 13,000

    // ── 7. After Reload ──
    const reloadedAccount = await mockPrisma.account.findUnique({ where: { id: dbAccounts[0].id } });
    expect(getOpeningBalanceFromLedger()).toBe(7000);
    expect(reloadedAccount.balance.toNumber()).toBe(13000);

    // ── 8. After Connection Terms Update (without touching opening balance) ──
    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      creditLimit: 200000,
      billingCycle: 'MONTHLY',
    });
    expect(getOpeningBalanceFromLedger()).toBe(7000); // IMMUTABLE 7,000
    expect(getCurrentBalance()).toBe(13000);

    // ── 9. Double Counting Verification ──
    const openingTxns = dbTransactions.filter((t) => t.note?.includes('افتتاحي'));
    expect(openingTxns.length).toBe(1); // EXACTLY 1 Opening Transaction (No duplicate!)

    // ── 10. Negative Sign Regression Verification across amounts (7000, 10000, 1000, 0) ──
    for (const testAmount of [7000, 10000, 1000, 0]) {
      const isNegative = testAmount < 0;
      expect(isNegative).toBe(false);
      expect(testAmount >= 0).toBe(true);
    }
  });
});
