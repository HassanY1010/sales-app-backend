import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { PrismaService } from '../database/prisma.service';
import { FinanceService } from '../finance/finance.service';
import { InvoiceNumberService } from '../common/invoice-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { TransactionsService } from '../transactions/transactions.service';
import Decimal from 'decimal.js';

describe('Final Comprehensive Verification & Audit for Invoice Accounting', () => {
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
      findUnique: jest.fn(async ({ where, include }: any) => {
        const o = dbOrders.find((x) => (where.id && x.id === where.id) || (where.clientId && x.clientId === where.clientId));
        if (!o) return null;
        const items = dbOrderItems.filter((it) => it.orderId === o.id);
        return { ...o, items };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return dbOrders.find((x) => {
          if (where.clientId && x.clientId === where.clientId) return true;
          if (where.id && x.id === where.id) return true;
          return false;
        }) || null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const id = `ord_${++seq}`;
        const newOrder = {
          id,
          ...data,
          items: [],
        };
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
        const newTxn = {
          id: `txn_${++seq}`,
          createdAt: new Date(),
          ...data,
        };
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
    customerSupplierLink: {
      findFirst: jest.fn(async () => null),
    },
    auditLog: {
      create: jest.fn(async () => ({ id: 'audit-1' })),
    },
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

  it('1. Partial Invoice Verification (4,500 Total / 1,500 Paid / 3,000 Remaining)', async () => {
    const order = await ordersService.createOrder(
      'merchant-1',
      {
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: false,
        paidAmount: '1500',
        items: [{ itemName: 'سكر', quantity: 3, unitPrice: '1500', unit: 'شوال' }],
      } as any,
      'business',
    );

    // Verify Order
    expect(new Decimal(order.total as any).toNumber()).toBe(4500);
    expect(new Decimal(order.paidAmount as any).toNumber()).toBe(1500);

    // Verify DB Transactions
    expect(dbTransactions.length).toBe(1); // EXACTLY 1 transaction
    expect(dbTransactions[0].transactionType).toBe('SALE');
    expect(new Decimal(dbTransactions[0].amount).toNumber()).toBe(4500);

    // Verify 0 Automatic Receipts
    const paymentTxns = dbTransactions.filter((t) => t.transactionType === 'PAYMENT');
    expect(paymentTxns.length).toBe(0);

    // Verify Account Balance
    expect(dbAccounts[0].balance.toNumber()).toBe(3000);
    expect(dbAccounts[0].totalDebit.toNumber()).toBe(3000);
  });

  it('2. Cash Invoice Verification (3,000 Total / 3,000 Paid / 0 Remaining)', async () => {
    const order = await ordersService.createOrder(
      'merchant-1',
      {
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: true,
        paidAmount: '3000',
        items: [{ itemName: 'أرز', quantity: 3, unitPrice: '1000', unit: 'كيس' }],
      } as any,
      'business',
    );

    // Verify Order
    expect(new Decimal(order.total as any).toNumber()).toBe(3000);
    expect(new Decimal(order.paidAmount as any).toNumber()).toBe(3000);

    // Verify DB Transactions
    expect(dbTransactions.length).toBe(1); // EXACTLY 1 SALE
    expect(dbTransactions[0].transactionType).toBe('SALE');
    expect(new Decimal(dbTransactions[0].amount).toNumber()).toBe(3000);

    // Verify 0 Automatic Receipts
    const paymentTxns = dbTransactions.filter((t) => t.transactionType === 'PAYMENT');
    expect(paymentTxns.length).toBe(0);

    // Verify Account Balance Impact = 0
    expect(dbAccounts[0].balance.toNumber()).toBe(0);
    expect(dbAccounts[0].totalDebit.toNumber()).toBe(0);
  });

  it('3. Credit Invoice Verification (5,000 Total / 0 Paid / 5,000 Remaining)', async () => {
    const order = await ordersService.createOrder(
      'merchant-1',
      {
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: false,
        paidAmount: '0',
        items: [{ itemName: 'زيت', quantity: 5, unitPrice: '1000', unit: 'دبة' }],
      } as any,
      'business',
    );

    expect(new Decimal(order.total as any).toNumber()).toBe(5000);
    expect(new Decimal(order.paidAmount as any).toNumber()).toBe(0);

    // Verify DB Transactions
    expect(dbTransactions.length).toBe(1);
    expect(dbTransactions[0].transactionType).toBe('SALE');
    expect(new Decimal(dbTransactions[0].amount).toNumber()).toBe(5000);

    // Verify 0 Automatic Receipts
    const paymentTxns = dbTransactions.filter((t) => t.transactionType === 'PAYMENT');
    expect(paymentTxns.length).toBe(0);

    // Verify Account Balance Impact = +5,000
    expect(dbAccounts[0].balance.toNumber()).toBe(5000);
    expect(dbAccounts[0].totalDebit.toNumber()).toBe(5000);
  });

  it('4. Manual Receipt After Partial Invoice (Partial 4,500/1,500 -> 3,000 -> Manual 1,000 -> 2,000 -> Manual 2,000 -> 0)', async () => {
    // 1. Create partial invoice
    await ordersService.createOrder(
      'merchant-1',
      {
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: false,
        paidAmount: '1500',
        items: [{ itemName: 'بضاعة', quantity: 1, unitPrice: '4500', unit: 'حبة' }],
      } as any,
      'business',
    );
    expect(dbAccounts[0].balance.toNumber()).toBe(3000);

    // 2. First Manual Receipt Voucher: 1,000
    await transactionsService.createTransaction('merchant-1', {
      receiverId: 'customer-1',
      amount: '1000',
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      connectionId: 'conn-1',
      note: 'سند قبض يدوي دفعة 1',
    } as any);
    expect(dbAccounts[0].balance.toNumber()).toBe(2000); // 3,000 - 1,000 = 2,000

    // 3. Second Manual Receipt Voucher: 2,000
    await transactionsService.createTransaction('merchant-1', {
      receiverId: 'customer-1',
      amount: '2000',
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      connectionId: 'conn-1',
      note: 'سند قبض يدوي دفعة 2',
    } as any);
    expect(dbAccounts[0].balance.toNumber()).toBe(0); // 2,000 - 2,000 = 0

    // Total transactions in DB = 3 (1 SALE + 2 Manual PAYMENT)
    expect(dbTransactions.length).toBe(3);
    const saleTxns = dbTransactions.filter((t) => t.transactionType === 'SALE');
    const paymentTxns = dbTransactions.filter((t) => t.transactionType === 'PAYMENT');
    expect(saleTxns.length).toBe(1);
    expect(paymentTxns.length).toBe(2);
  });

  it('5. Invoice Editing Test (Raise 4,500/1,500 -> 6,000/1,500 -> Balance becomes 4,500, zero duplicate PAYMENT)', async () => {
    // 1. Initial partial invoice: 4,500 total, 1,500 paid -> Balance = 3,000
    const order = await ordersService.createOrder(
      'merchant-1',
      {
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: false,
        paidAmount: '1500',
        items: [
          { itemName: 'صنف 1', quantity: 1, unitPrice: '4500', unit: 'حبة' },
        ],
      } as any,
      'business',
    );
    expect(dbAccounts[0].balance.toNumber()).toBe(3000);

    // For draft/unapproved orders with invoiceId, direct update adjusts balance
    const existingOrder = dbOrders.find((o) => o.id === order.id);
    if (existingOrder) {
      existingOrder.invoiceId = dbTransactions[0].id;
      existingOrder.pricesVisible = false;
    }

    // 2. Edit price to 6,000 (unitPrice: 4500 -> 6000), paidAmount stays 1500 -> Remaining becomes 4,500
    await ordersService.updateOrderPrices(
      'merchant-1',
      order.id,
      {
        items: [{ id: order.items[0].id, unitPrice: '6000' }],
      } as any,
      'business',
    );

    // Verify Balance updated to exact 4,500
    expect(dbAccounts[0].balance.toNumber()).toBe(4500);

    // Verify NO PAYMENT transaction created during edit
    const payments = dbTransactions.filter((t) => t.transactionType === 'PAYMENT');
    expect(payments.length).toBe(0);
  });

  it('6. Balance Rebuild Match (Cash 3k + Partial 4.5k/1.5k + Credit 5k - Manual Receipt 1k = 7,000)', async () => {
    // 1. Cash Invoice: 3,000 / 3,000 -> +0
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

    // 2. Partial Invoice: 4,500 / 1,500 -> +3,000
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

    // 3. Credit Invoice: 5,000 / 0 -> +5,000
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

    // 4. Manual Receipt: 1,000 -> -1,000
    await transactionsService.createTransaction('merchant-1', {
      receiverId: 'customer-1',
      amount: '1000',
      transactionType: 'PAYMENT',
      paymentDirection: 'RECEIVED',
      connectionId: 'conn-1',
      note: 'سند قبض',
    } as any);

    // Current Balance = 0 + 3,000 + 5,000 - 1,000 = 7,000
    expect(dbAccounts[0].balance.toNumber()).toBe(7000);

    // Rebuild Account Balance from Ledger Truth
    await financeService.rebuildAccountBalance('acc-1');

    // Rebuilt Balance MUST be exactly 7,000
    expect(dbAccounts[0].balance.toNumber()).toBe(7000);
  });

  it('7. Direct Database Zero-Duplicate Verification', async () => {
    // Create Cash Invoice
    const cashOrder = await ordersService.createOrder(
      'merchant-1',
      {
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: true,
        paidAmount: '3000',
        items: [{ itemName: 'صنف', quantity: 1, unitPrice: '3000', unit: 'حبة' }],
      } as any,
      'business',
    );

    const cashTxns = dbTransactions.filter((t) => t.orderId === cashOrder.id);
    expect(cashTxns.length).toBe(1);
    expect(cashTxns[0].transactionType).toBe('SALE');

    // Create Partial Invoice
    const partialOrder = await ordersService.createOrder(
      'merchant-1',
      {
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: false,
        paidAmount: '1500',
        items: [{ itemName: 'صنف', quantity: 1, unitPrice: '4500', unit: 'حبة' }],
      } as any,
      'business',
    );

    const partialTxns = dbTransactions.filter((t) => t.orderId === partialOrder.id);
    expect(partialTxns.length).toBe(1);
    expect(partialTxns[0].transactionType).toBe('SALE');

    // Total PAYMENT transactions in DB for both invoices is ZERO
    const allPayments = dbTransactions.filter((t) => t.transactionType === 'PAYMENT');
    expect(allPayments.length).toBe(0);
  });

  it('8. Retry & Idempotency Test (Repeating same invoice creation produces no duplicate transactions)', async () => {
    const clientId = 'device-uuid-12345';

    // First attempt
    const order1 = await ordersService.createOrder(
      'merchant-1',
      {
        clientId,
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: false,
        paidAmount: '1500',
        items: [{ itemName: 'صنف', quantity: 1, unitPrice: '4500', unit: 'حبة' }],
      } as any,
      'business',
    );

    expect(dbOrders.length).toBe(1);
    expect(dbTransactions.length).toBe(1);
    expect(dbAccounts[0].balance.toNumber()).toBe(3000);

    // Second attempt with same clientId (Network Retry / Sync Retry)
    const order2 = await ordersService.createOrder(
      'merchant-1',
      {
        clientId,
        receiverId: 'customer-1',
        connectionId: 'conn-1',
        accountRole: 'CUSTOMER',
        isCash: false,
        paidAmount: '1500',
        items: [{ itemName: 'صنف', quantity: 1, unitPrice: '4500', unit: 'حبة' }],
      } as any,
      'business',
    );

    // Still exactly 1 order, 1 transaction, and balance remains 3,000 (No duplicate!)
    expect(order2.id).toBe(order1.id);
    expect(dbOrders.length).toBe(1);
    expect(dbTransactions.length).toBe(1);
    expect(dbAccounts[0].balance.toNumber()).toBe(3000);
  });
});
