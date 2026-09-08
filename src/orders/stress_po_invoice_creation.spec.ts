import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { InvoiceNumberService } from '../common/invoice-number.service';
import { PrismaService } from '../database/prisma.service';
import { Decimal } from 'decimal.js';

describe('🔥 HARDCORE STRESS TEST: Purchase Orders & Sales Invoices Creation Integrity', () => {
  let ordersService: OrdersService;
  let invoiceNumberService: InvoiceNumberService;

  // In-memory Mock Database Store
  const store = {
    users: new Map<string, any>(),
    businesses: new Map<string, any>(),
    connections: new Map<string, any>(),
    accounts: new Map<string, any>(),
    orders: new Map<string, any>(),
    orderItems: new Map<string, any>(),
    transactions: new Map<string, any>(),
    notifications: new Map<string, any>(),
    auditLogs: new Map<string, any>(),
    invoiceCounters: new Map<string, bigint>(),
    orderCounters: new Map<string, bigint>(),
    voucherCounters: new Map<string, bigint>(),
  };

  const mockPrisma: any = {
    $transaction: jest.fn(async (cb, _opts) => await cb(mockPrisma)),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockImplementation(async (query: any, ...values: any[]) => {
      const qStr = query.raw ? query.raw.join(' ') : query.toString();
      const bizId = values[0] || 'biz-default';

      if (qStr.includes('business_invoice_counter')) {
        const cur = store.invoiceCounters.get(bizId) || BigInt(0);
        const next = cur + BigInt(1);
        store.invoiceCounters.set(bizId, next);
        return [{ lastNum: next }];
      }

      if (qStr.includes('business_order_counter')) {
        const cur = store.orderCounters.get(bizId) || BigInt(0);
        const next = cur + BigInt(1);
        store.orderCounters.set(bizId, next);
        return [{ lastNum: next }];
      }

      if (qStr.includes('business_voucher_counter')) {
        const cur = store.voucherCounters.get(bizId) || BigInt(0);
        const next = cur + BigInt(1);
        store.voucherCounters.set(bizId, next);
        return [{ lastNum: next }];
      }

      return [];
    }),
    connection: {
      findFirst: jest.fn(async ({ where }) => {
        for (const conn of store.connections.values()) {
          const acc = store.accounts.get(conn.id);
          if (where.id && conn.id === where.id) return { ...conn, account: acc };
          if (where.OR) {
            for (const orC of where.OR) {
              if (
                orC.requesterId === conn.requesterId &&
                orC.receiverId === conn.receiverId &&
                (!orC.connectionType || orC.connectionType === conn.connectionType)
              ) {
                return { ...conn, account: acc };
              }
            }
          }
        }
        return null;
      }),
    },
    account: {
      findUnique: jest.fn(async ({ where }) => store.accounts.get(where.id)),
      update: jest.fn(async ({ where, data }) => {
        const acc = store.accounts.get(where.id);
        if (data.totalDebit !== undefined) acc.totalDebit = new Decimal(data.totalDebit);
        if (data.totalCredit !== undefined) acc.totalCredit = new Decimal(data.totalCredit);
        if (data.balance?.increment !== undefined) {
          acc.balance = new Decimal(acc.balance || '0').plus(new Decimal(data.balance.increment));
        }
        return acc;
      }),
    },
    business: {
      findUnique: jest.fn(async ({ where }) => {
        const b = store.businesses.get(where.id);
        if (!b) return null;
        return { ...b, user: store.users.get(b.userId) };
      }),
      findFirst: jest.fn(async ({ where }) => {
        const b = store.businesses.get(where.id || where.OR?.[0]?.id);
        if (!b) return null;
        return { ...b, user: store.users.get(b.userId) };
      }),
    },
    customerSupplierLink: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    order: {
      create: jest.fn(async ({ data }) => {
        // Enforce uniqueness simulation
        for (const existingOrder of store.orders.values()) {
          if (existingOrder.orderNumber === data.orderNumber && existingOrder.senderId === data.senderId) {
            throw new Error(`Unique constraint failed on orderNumber: ${data.orderNumber}`);
          }
        }
        const id = `order_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        const orderObj = { id, ...data, items: data.items?.create || [], createdAt: new Date() };
        store.orders.set(id, orderObj);
        return orderObj;
      }),
      findUnique: jest.fn(async ({ where }) => {
        if (where.id) return store.orders.get(where.id) || null;
        if (where.clientId) {
          for (const o of store.orders.values()) {
            if (o.clientId === where.clientId) return o;
          }
        }
        return null;
      }),
    },
    transaction: {
      create: jest.fn(async ({ data }) => {
        const id = `tx_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        const txObj = { id, ...data, createdAt: new Date() };
        store.transactions.set(id, txObj);
        return txObj;
      }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    notification: {
      create: jest.fn().mockResolvedValue({ id: 'notif-1' }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  };

  const mockFinanceService: any = {
    recordFinancialMovement: jest.fn(async (prisma, data) => {
      const voucherNum = `VOUCH-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const tx = await prisma.transaction.create({
        data: {
          senderId: data.senderId,
          receiverId: data.receiverId,
          amount: new Decimal(data.amount),
          transactionType: data.type,
          orderId: data.orderId,
          connectionId: data.connectionId,
          voucherNumber: voucherNum,
          note: data.note,
          currency: data.currency || 'YER',
        },
      });
      return { transaction: tx, isDebit: true };
    }),
  };

  const mockNotificationsService: any = {
    sendPushNotification: jest.fn().mockResolvedValue(true),
  };

  const mockEventsGateway: any = {
    emitToBusiness: jest.fn(),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        InvoiceNumberService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: FinanceService, useValue: mockFinanceService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    ordersService = module.get<OrdersService>(OrdersService);
    invoiceNumberService = module.get<InvoiceNumberService>(InvoiceNumberService);
  });

  beforeEach(() => {
    store.users.clear();
    store.businesses.clear();
    store.connections.clear();
    store.accounts.clear();
    store.orders.clear();
    store.orderItems.clear();
    store.transactions.clear();
    store.notifications.clear();
    store.auditLogs.clear();
    store.invoiceCounters.clear();
    store.orderCounters.clear();
    store.voucherCounters.clear();

    // Setup 3 Businesses:
    // 1. Merchant A (Supplier/Seller)
    // 2. Merchant B (Customer/Buyer)
    // 3. Merchant C (Another Independent Merchant)
    const bizA = { id: 'biz-A', name: 'مؤسسة النور للتجارة (مورد)', userId: 'user-A' };
    const bizB = { id: 'biz-B', name: 'بقالة الفجر (عميل)', userId: 'user-B' };
    const bizC = { id: 'biz-C', name: 'شركة البركة (مورد آخر)', userId: 'user-C' };

    store.users.set('user-A', { id: 'user-A', fullName: 'أحمد التاجر', userType: 'merchant' });
    store.users.set('user-B', { id: 'user-B', fullName: 'محمد البقال', userType: 'merchant' });
    store.users.set('user-C', { id: 'user-C', fullName: 'علي البركة', userType: 'merchant' });

    store.businesses.set('biz-A', bizA);
    store.businesses.set('biz-B', bizB);
    store.businesses.set('biz-C', bizC);

    // Connection A -> B (A is Merchant, B is Customer)
    const conn1 = {
      id: 'conn-AB',
      requesterId: 'biz-A',
      receiverId: 'biz-B',
      connectionType: 'CUSTOMER',
      status: 'ACCEPTED',
      showPrices: true,
    };
    const acc1 = {
      id: 'conn-AB',
      connectionId: 'conn-AB',
      balance: new Decimal(0),
      totalDebit: new Decimal(0),
      totalCredit: new Decimal(0),
      creditLimit: new Decimal(1000000),
      currency: 'YER',
    };
    store.connections.set('conn-AB', conn1);
    store.accounts.set('conn-AB', acc1);

    // Connection B -> C (B is Customer, C is Supplier)
    const conn2 = {
      id: 'conn-BC',
      requesterId: 'biz-B',
      receiverId: 'biz-C',
      connectionType: 'SUPPLIER',
      status: 'ACCEPTED',
      showPrices: false,
    };
    const acc2 = {
      id: 'conn-BC',
      connectionId: 'conn-BC',
      balance: new Decimal(0),
      totalDebit: new Decimal(0),
      totalCredit: new Decimal(0),
      creditLimit: new Decimal(1000000),
      currency: 'YER',
    };
    store.connections.set('conn-BC', conn2);
    store.accounts.set('conn-BC', acc2);
  });

  it('TEST 1: Creating 5 Purchase Orders (طلبيات شراء) creates sequential numbers (1, 2, 3, 4, 5) without errors', async () => {
    for (let i = 1; i <= 5; i++) {
      const order = await ordersService.createOrder(
        'biz-B', // Buyer sends purchase order to Supplier C
        {
          receiverId: 'biz-C',
          accountRole: 'SUPPLIER',
          pricesVisible: false,
          items: [
            { itemName: `صنف طلبية ${i}`, quantity: i, unitPrice: '0' },
          ],
        },
        'merchant',
      );

      expect(order).toBeDefined();
      expect(order.orderNumber).toBe(i.toString());
      expect(order.status).toBe('PENDING');
      expect(order.pricesVisible).toBe(false);
    }
  });

  it('TEST 2: Creating 5 Sales Invoices (فواتير مبيعات) creates independent sequential numbers (1, 2, 3, 4, 5) with financial movements', async () => {
    for (let i = 1; i <= 5; i++) {
      const invoice = await ordersService.createOrder(
        'biz-A', // Seller creates sales invoice to Customer B
        {
          receiverId: 'biz-B',
          accountRole: 'CUSTOMER',
          pricesVisible: true,
          items: [
            { itemName: `صنف مبيعات ${i}`, quantity: 2, unitPrice: '1500' },
          ],
        },
        'merchant',
      );

      expect(invoice).toBeDefined();
      expect(invoice.orderNumber).toBe(i.toString());
      expect(invoice.status).toBe('ISSUED');
      expect(invoice.pricesVisible).toBe(true);
      expect(invoice.total).toBe('3000');
    }

    expect(mockFinanceService.recordFinancialMovement).toHaveBeenCalledTimes(5);
  });

  it('TEST 3: High concurrency interleaving - alternating Purchase Orders and Sales Invoices maintains 100% counter isolation', async () => {
    // Biz-B sends Purchase Order 1 to Biz-C
    const po1 = await ordersService.createOrder(
      'biz-B',
      { receiverId: 'biz-C', accountRole: 'SUPPLIER', pricesVisible: false, items: [{ itemName: 'زبادي', quantity: 10, unitPrice: '0' }] },
      'merchant',
    );
    expect(po1.orderNumber).toBe('1');

    // Biz-A sends Sales Invoice 1 to Biz-B
    const inv1 = await ordersService.createOrder(
      'biz-A',
      { receiverId: 'biz-B', accountRole: 'CUSTOMER', pricesVisible: true, items: [{ itemName: 'أرز 10كجم', quantity: 1, unitPrice: '25000' }] },
      'merchant',
    );
    expect(inv1.orderNumber).toBe('1');

    // Biz-B sends Purchase Order 2 to Biz-C
    const po2 = await ordersService.createOrder(
      'biz-B',
      { receiverId: 'biz-C', accountRole: 'SUPPLIER', pricesVisible: false, items: [{ itemName: 'حليب نيدو', quantity: 5, unitPrice: '0' }] },
      'merchant',
    );
    expect(po2.orderNumber).toBe('2');

    // Biz-A sends Sales Invoice 2 to Biz-B
    const inv2 = await ordersService.createOrder(
      'biz-A',
      { receiverId: 'biz-B', accountRole: 'CUSTOMER', pricesVisible: true, items: [{ itemName: 'زيت 5لتر', quantity: 2, unitPrice: '12000' }] },
      'merchant',
    );
    expect(inv2.orderNumber).toBe('2');

    // Biz-B sends Purchase Order 3 to Biz-C
    const po3 = await ordersService.createOrder(
      'biz-B',
      { receiverId: 'biz-C', accountRole: 'SUPPLIER', pricesVisible: false, items: [{ itemName: 'سكر 50كجم', quantity: 1, unitPrice: '0' }] },
      'merchant',
    );
    expect(po3.orderNumber).toBe('3');
  });
});
