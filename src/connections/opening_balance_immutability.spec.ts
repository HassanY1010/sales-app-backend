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

describe('Opening Balance Immutability & Ledger Integrity Verification', () => {
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

  it('TEST 1: Opening Balance Only (7,000) -> Opening is +7,000, Balance is +7,000', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 7000,
    });

    const acc = dbAccounts[0];
    expect(acc.balance.toNumber()).toBe(7000);

    // Verify Opening Transaction
    const openingTxn = dbTransactions.find((t) => t.note?.includes('افتتاحي'));
    expect(openingTxn).toBeDefined();
    expect(new Decimal(openingTxn.amount).toNumber()).toBe(7000);
  });

  it('TEST 2: Opening Balance (7,000) + Credit Invoice (6,000) -> Opening stays 7,000, Balance is 13,000', async () => {
    // 1. Create customer with opening balance 7,000
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 7000,
    });
    expect(dbAccounts[0].balance.toNumber()).toBe(7000);

    // 2. Create Credit Invoice for 6,000
    const order = await ordersService.createOrder('biz-merchant', {
      receiverId: 'biz-customer',
      connectionId: conn.id,
      accountRole: 'CUSTOMER',
      isCash: false,
      paidAmount: '0',
      items: [{ itemName: 'بضاعة', quantity: 1, unitPrice: '6000', unit: 'كرتون' }],
    } as any, 'business');

    // Verify:
    // Opening Transaction in DB is STILL exactly 7,000 (Immutable!)
    const openingTxn = dbTransactions.find((t) => t.note?.includes('افتتاحي'));
    expect(new Decimal(openingTxn.amount).toNumber()).toBe(7000);

    // Invoice Transaction is 6,000
    const invoiceTxn = dbTransactions.find((t) => t.orderId === order.id);
    expect(new Decimal(invoiceTxn.amount).toNumber()).toBe(6000);

    // Customer Account Balance is 7,000 + 6,000 = 13,000
    expect(dbAccounts[0].balance.toNumber()).toBe(13000);
  });

  it('TEST 3: Opening Balance (7,000) + 3 Invoices (2,000, 3,000, 1,000) -> Opening stays 7,000, Balance is 13,000', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 7000,
    });

    for (const amount of [2000, 3000, 1000]) {
      await ordersService.createOrder('biz-merchant', {
        receiverId: 'biz-customer',
        connectionId: conn.id,
        accountRole: 'CUSTOMER',
        isCash: false,
        paidAmount: '0',
        items: [{ itemName: 'صنف', quantity: 1, unitPrice: amount.toString(), unit: 'حبة' }],
      } as any, 'business');
    }

    // Opening balance stays 7,000
    const openingTxn = dbTransactions.find((t) => t.note?.includes('افتتاحي'));
    expect(new Decimal(openingTxn.amount).toNumber()).toBe(7000);

    // Final balance is 7,000 + 2,000 + 3,000 + 1,000 = 13,000
    expect(dbAccounts[0].balance.toNumber()).toBe(13000);
  });

  it('TEST 4: Opening Balance (7,000) + Receipt Voucher (2,000) -> Balance is 5,000, Opening stays 7,000', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 7000,
    });

    await transactionsService.createTransaction('biz-merchant', {
      receiverId: 'biz-customer',
      amount: '2000',
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      connectionId: conn.id,
      note: 'سند قبض',
    } as any);

    // Opening balance is still 7,000
    const openingTxn = dbTransactions.find((t) => t.note?.includes('افتتاحي'));
    expect(new Decimal(openingTxn.amount).toNumber()).toBe(7000);

    // Final balance is 7,000 - 2,000 = 5,000
    expect(dbAccounts[0].balance.toNumber()).toBe(5000);
  });

  it('TEST 5: Mixed Lifecycle (Opening 7k -> Inv 6k -> Rec 2k -> Inv 3k -> Rec 4k) -> Balance = 10,000', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 7000,
    });

    // Invoice 6,000
    await ordersService.createOrder('biz-merchant', {
      receiverId: 'biz-customer',
      connectionId: conn.id,
      accountRole: 'CUSTOMER',
      isCash: false,
      paidAmount: '0',
      items: [{ itemName: 'بضاعة 1', quantity: 1, unitPrice: '6000', unit: 'حبة' }],
    } as any, 'business');

    // Receipt 2,000
    await transactionsService.createTransaction('biz-merchant', {
      receiverId: 'biz-customer',
      amount: '2000',
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      connectionId: conn.id,
    } as any);

    // Invoice 3,000
    await ordersService.createOrder('biz-merchant', {
      receiverId: 'biz-customer',
      connectionId: conn.id,
      accountRole: 'CUSTOMER',
      isCash: false,
      paidAmount: '0',
      items: [{ itemName: 'بضاعة 2', quantity: 1, unitPrice: '3000', unit: 'حبة' }],
    } as any, 'business');

    // Receipt 4,000
    await transactionsService.createTransaction('biz-merchant', {
      receiverId: 'biz-customer',
      amount: '4000',
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      connectionId: conn.id,
    } as any);

    // Opening 7,000 + 6,000 - 2,000 + 3,000 - 4,000 = 10,000
    expect(dbAccounts[0].balance.toNumber()).toBe(10000);

    // Rebuild balance from ledger
    await financeService.rebuildAccountBalance(dbAccounts[0].id);
    expect(dbAccounts[0].balance.toNumber()).toBe(10000);
  });

  it('TEST 6: Editing Opening Balance via updateAccountTerms updates Opening & Rebuilds correctly', async () => {
    const conn = await connectionsService.manualAddConnection('biz-merchant', {
      phoneNumber: '777222333',
      name: 'محلات الناصر',
      connectionType: 'CUSTOMER',
      openingBalance: 7000,
    });
    expect(dbAccounts[0].balance.toNumber()).toBe(7000);

    // Update opening balance to 9,000
    await connectionsService.updateAccountTerms('biz-merchant', conn.id, {
      creditLimit: 100000,
      openingBalance: 9000,
    });

    expect(dbAccounts[0].balance.toNumber()).toBe(9000);
    const openingTxn = dbTransactions.find((t) => t.note?.includes('افتتاحي'));
    expect(new Decimal(openingTxn.amount).toNumber()).toBe(9000);
  });
});
