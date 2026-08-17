import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { PrismaService } from '../database/prisma.service';
import { FinanceService } from '../finance/finance.service';
import { InvoiceNumberService } from '../common/invoice-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { TransactionsService } from '../transactions/transactions.service';
import Decimal from 'decimal.js';

describe('Final Accounting Integrity & Historical Safety Audit', () => {
  let ordersService: OrdersService;
  let financeService: FinanceService;
  let transactionsService: TransactionsService;

  let dbOrders: any[] = [];
  let dbOrderItems: any[] = [];
  let dbTransactions: any[] = [];
  let dbAccounts: any[] = [];
  let dbConnections: any[] = [];
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
    order: {
      findUnique: jest.fn(async ({ where }: any) => {
        const o = dbOrders.find((x) => (where.id && x.id === where.id) || (where.clientId && x.clientId === where.clientId));
        if (!o) return null;
        const items = dbOrderItems.filter((it) => it.orderId === o.id);
        return { ...o, items };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return dbOrders.find((x) => (where.clientId && x.clientId === where.clientId) || (where.id && x.id === where.id)) || null;
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
        const idx = dbOrders.findIndex((x) => x.id === where.id);
        if (idx !== -1) {
          dbOrders[idx] = { ...dbOrders[idx], ...data };
          return dbOrders[idx];
        }
        return null;
      }),
    },
    orderItem: {
      update: jest.fn(async ({ where, data }: any) => {
        const it = dbOrderItems.find((x) => x.id === where.id);
        if (it) Object.assign(it, data);
        return it;
      }),
    },
    transaction: {
      findUnique: jest.fn(async ({ where }: any) => {
        return dbTransactions.find((t) => t.id === where.id || (where.clientId && t.clientId === where.clientId)) || null;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return dbTransactions.find((t) => {
          if (where.id && t.id === where.id) return true;
          if (where.orderId && t.orderId === where.orderId && where.transactionType && t.transactionType === where.transactionType) return true;
          if (where.clientId && t.clientId === where.clientId) return true;
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
    },
    connection: {
      findFirst: jest.fn(async () => {
        const c = dbConnections[0];
        if (!c) return null;
        const acc = dbAccounts.find((a) => a.id === c.accountId);
        return { ...c, account: acc };
      }),
      findMany: jest.fn(async () => {
        return dbConnections.map((c) => ({
          ...c,
          account: dbAccounts.find((a) => a.id === c.accountId),
        }));
      }),
    },
    account: {
      findUnique: jest.fn(async ({ where }: any) => {
        const acc = dbAccounts.find((a) => a.id === where.id);
        if (!acc) return null;
        const conn = dbConnections.find((c) => c.accountId === acc.id);
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
        if (acc.balance.greaterThan(0)) {
          acc.totalDebit = acc.balance;
          acc.totalCredit = new Decimal(0);
        } else {
          acc.totalCredit = acc.balance.abs();
          acc.totalDebit = new Decimal(0);
        }
        return acc;
      }),
    },
    business: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        name: where.id === 'merchant-1' ? 'شركة التوريدات' : 'بقالة صنعاء',
        user: { id: `user-${where.id}` },
      })),
      findFirst: jest.fn(async () => null),
    },
    customerSupplierLink: { findFirst: jest.fn(async () => null) },
    auditLog: { create: jest.fn(async () => ({ id: 'audit-1' })) },
  };

  beforeEach(async () => {
    dbOrders = [];
    dbOrderItems = [];
    dbTransactions = [];
    dbAccounts = [];
    dbConnections = [];
    seq = 0;

    const testAccount = {
      id: 'acc-1',
      balance: new Decimal(0),
      totalDebit: new Decimal(0),
      totalCredit: new Decimal(0),
      creditLimit: new Decimal(100000),
      currency: 'YER',
    };
    dbAccounts.push(testAccount);

    const testConnection = {
      id: 'conn-1',
      requesterId: 'merchant-1',
      receiverId: 'customer-1',
      connectionType: 'CUSTOMER',
      status: 'ACCEPTED',
      showPrices: true,
      accountId: 'acc-1',
    };
    dbConnections.push(testConnection);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        FinanceService,
        TransactionsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: InvoiceNumberService, useValue: mockInvoiceNumberService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    ordersService = module.get<OrdersService>(OrdersService);
    financeService = module.get<FinanceService>(FinanceService);
    transactionsService = module.get<TransactionsService>(TransactionsService);
  });

  it('AUDIT 1: Invoice Edit Ledger Integrity (Original = 3,000, Delta = +1,500, Final = 4,500)', async () => {
    // 1. Initial partial invoice: 4,500 total, 1,500 paid -> Balance = 3,000
    const order = await ordersService.createOrder(
      'merchant-1',
      {
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: false,
        paidAmount: '1500',
        items: [{ itemName: 'سكر', quantity: 1, unitPrice: '4500', unit: 'كيس' }],
      } as any,
      'business',
    );
    order.invoiceId = dbTransactions[0].id;
    expect(dbAccounts[0].balance.toNumber()).toBe(3000);

    // 2. Edit price from 4,500 -> 6,000 (paidAmount remains 1,500)
    await ordersService.updateOrderPrices(
      'merchant-1',
      order.id,
      {
        items: [{ id: order.items[0].id, unitPrice: '6000' }],
      } as any,
      'business',
    );

    // Verify Ledger Entries
    // Txn 1: Initial SALE (4,500) -> Net Impact = 3,000
    // Txn 2: Edit Delta SALE (1,500) -> Net Impact = +1,500
    expect(dbTransactions.length).toBe(2);
    expect(dbTransactions[0].transactionType).toBe('SALE');
    expect(new Decimal(dbTransactions[0].amount).toNumber()).toBe(4500);
    expect(dbTransactions[1].transactionType).toBe('SALE');
    expect(new Decimal(dbTransactions[1].amount).toNumber()).toBe(1500);

    // Final Outstanding must be exactly 4,500 (No inflation to 3,000 + 4,500 or 4,500 + 4,500)
    expect(dbAccounts[0].balance.toNumber()).toBe(4500);
  });

  it('AUDIT 2: Fresh Rebuild Verification (Stored Account Balance vs Rebuilt Ledger Balance vs Expected Balance)', async () => {
    // 1. Cash Invoice: 3,000 / 3,000 -> Impact: 0
    await ordersService.createOrder(
      'merchant-1',
      {
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: true,
        paidAmount: '3000',
        items: [{ itemName: 'نقد', quantity: 1, unitPrice: '3000', unit: 'حبة' }],
      } as any,
      'business',
    );

    // 2. Partial Invoice: 4,500 / 1,500 -> Impact: +3,000
    await ordersService.createOrder(
      'merchant-1',
      {
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: false,
        paidAmount: '1500',
        items: [{ itemName: 'جزئي', quantity: 1, unitPrice: '4500', unit: 'حبة' }],
      } as any,
      'business',
    );

    // 3. Credit Invoice: 5,000 / 0 -> Impact: +5,000
    await ordersService.createOrder(
      'merchant-1',
      {
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: false,
        paidAmount: '0',
        items: [{ itemName: 'آجل', quantity: 1, unitPrice: '5000', unit: 'حبة' }],
      } as any,
      'business',
    );

    // 4. Manual Receipt Voucher: 1,000 -> Impact: -1,000
    await transactionsService.createTransaction('merchant-1', {
      receiverId: 'customer-1',
      amount: '1000',
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      connectionId: 'conn-1',
      note: 'سند قبض يدوي',
    } as any);

    const storedBalance = dbAccounts[0].balance.toNumber();
    const expectedMathBalance = 0 + 3000 + 5000 - 1000; // 7,000

    expect(storedBalance).toBe(expectedMathBalance);

    // Now reset stored account balance to 0 and perform a complete fresh rebuild from ledger entries
    dbAccounts[0].balance = new Decimal(0);
    await financeService.rebuildAccountBalance('acc-1');
    const rebuiltLedgerBalance = dbAccounts[0].balance.toNumber();

    // Stored == Rebuilt == Expected == 7,000
    expect(storedBalance).toBe(7000);
    expect(rebuiltLedgerBalance).toBe(7000);
    expect(expectedMathBalance).toBe(7000);
    expect(storedBalance).toBe(rebuiltLedgerBalance);
    expect(rebuiltLedgerBalance).toBe(expectedMathBalance);
  });

  it('AUDIT 3: Historical Data Safety & Non-destruction of Manual Payments', async () => {
    // If a legacy manual payment voucher exists in DB with no orderId (genuine manual payment):
    const legacyManualPayment = {
      id: `txn_${++seq}`,
      createdAt: new Date('2025-01-01'),
      senderId: 'customer-1',
      receiverId: 'merchant-1',
      amount: '500',
      transactionType: 'PAYMENT',
      orderId: null,
      connectionId: 'conn-1',
      note: 'سند يدوي قديم',
    };
    dbTransactions.push(legacyManualPayment);

    // When rebuildAccountBalance runs, it correctly subtracts manual payment
    await financeService.rebuildAccountBalance('acc-1');
    expect(dbAccounts[0].balance.toNumber()).toBe(-500); // Customer is in credit (-500)
  });
});
