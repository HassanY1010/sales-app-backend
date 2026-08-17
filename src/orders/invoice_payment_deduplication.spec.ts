import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { PrismaService } from '../database/prisma.service';
import { FinanceService } from '../finance/finance.service';
import { InvoiceNumberService } from '../common/invoice-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import Decimal from 'decimal.js';

describe('Invoice Payment Deduplication & Accounting Truth Table Tests', () => {
  let ordersService: OrdersService;
  let financeService: FinanceService;
  let prisma: PrismaService;

  const mockEventsGateway = {
    emitToBusiness: jest.fn(),
  };

  const mockNotificationsService = {
    sendPushNotification: jest.fn(),
  };

  const mockInvoiceNumberService = {
    generateInvoiceNumber: jest.fn().mockResolvedValue('INV-2026-001'),
    getNextInvoiceNumber: jest.fn().mockResolvedValue('INV-2026-001'),
  };

  let mockDbOrders: any[] = [];
  let mockDbTransactions: any[] = [];
  let mockAccount: any;
  let mockConnection: any;

  beforeEach(async () => {
    mockDbOrders = [];
    mockDbTransactions = [];

    mockAccount = {
      id: 'acc-cust-1',
      balance: new Decimal(0),
      totalDebit: new Decimal(0),
      totalCredit: new Decimal(0),
      creditLimit: new Decimal(100000),
      currency: 'YER',
    };

    mockConnection = {
      id: 'conn-cust-1',
      requesterId: 'merchant-biz-1',
      receiverId: 'customer-biz-2',
      connectionType: 'CUSTOMER',
      status: 'ACCEPTED',
      showPrices: true,
      account: mockAccount,
    };
    mockAccount.connection = mockConnection;

    const mockPrismaService: any = {
      $transaction: jest.fn(async (cb) => cb(mockPrismaService)),
      $executeRaw: jest.fn().mockResolvedValue(1),
      order: {
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          return mockDbOrders.find((o) => o.id === where.id) || null;
        }),
        findFirst: jest.fn().mockImplementation(async ({ where }) => {
          return mockDbOrders.find((o) => {
            if (where.clientId && o.clientId === where.clientId) return true;
            if (where.id && o.id === where.id) return true;
            return false;
          }) || null;
        }),
        create: jest.fn().mockImplementation(async ({ data }) => {
          const newOrder = {
            id: `ord-${Date.now()}-${Math.random()}`,
            ...data,
            items: data.items?.create || [],
          };
          mockDbOrders.push(newOrder);
          return newOrder;
        }),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          const idx = mockDbOrders.findIndex((o) => o.id === where.id);
          if (idx !== -1) {
            mockDbOrders[idx] = { ...mockDbOrders[idx], ...data };
            return mockDbOrders[idx];
          }
          return null;
        }),
      },
      transaction: {
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          return mockDbTransactions.find((t) => t.id === where.id || (where.clientId && t.clientId === where.clientId)) || null;
        }),
        findFirst: jest.fn().mockImplementation(async ({ where }) => {
          return mockDbTransactions.find((t) => {
            if (where.orderId && t.orderId === where.orderId && where.transactionType && t.transactionType === where.transactionType) return true;
            if (where.clientId && t.clientId === where.clientId) return true;
            return false;
          }) || null;
        }),
        findMany: jest.fn().mockImplementation(async () => {
          return mockDbTransactions.map((t) => ({
            ...t,
            order: mockDbOrders.find((o) => o.id === t.orderId) || null,
          }));
        }),
        create: jest.fn().mockImplementation(async ({ data }) => {
          const newTxn = {
            id: `txn-${Date.now()}-${Math.random()}`,
            ...data,
          };
          mockDbTransactions.push(newTxn);
          return newTxn;
        }),
      },
      connection: {
        findFirst: jest.fn().mockImplementation(async () => mockConnection),
        findMany: jest.fn().mockImplementation(async () => [mockConnection]),
      },
      account: {
        findUnique: jest.fn().mockImplementation(async () => mockAccount),
        update: jest.fn().mockImplementation(async ({ data }) => {
          if (data.balance?.increment !== undefined) {
            mockAccount.balance = mockAccount.balance.plus(new Decimal(data.balance.increment));
          } else if (data.balance !== undefined) {
            mockAccount.balance = new Decimal(data.balance);
          }
          if (mockAccount.balance.greaterThan(0)) {
            mockAccount.totalDebit = mockAccount.balance;
            mockAccount.totalCredit = new Decimal(0);
          } else {
            mockAccount.totalCredit = mockAccount.balance.abs();
            mockAccount.totalDebit = new Decimal(0);
          }
          return mockAccount;
        }),
      },
      business: {
        findUnique: jest.fn().mockImplementation(async ({ where }) => ({
          id: where.id,
          name: where.id === 'merchant-biz-1' ? 'تاجر الجملة' : 'بقالة صنعاء',
          user: { id: `user-${where.id}`, name: 'User' },
        })),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      customerSupplierLink: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        FinanceService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: InvoiceNumberService, useValue: mockInvoiceNumberService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    ordersService = module.get<OrdersService>(OrdersService);
    financeService = module.get<FinanceService>(FinanceService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('Truth Table Verification: Zero Duplicate Receipt Vouchers on Invoices', () => {
    it('TEST 1: Cash Invoice (Total = 3,000, Paid = 3,000) -> Balance Impact = 0, Auto Receipt = NONE', async () => {
      const order = await ordersService.createOrder(
        'merchant-biz-1',
        {
          receiverId: 'customer-biz-2',
          connectionId: 'conn-cust-1',
          accountRole: 'CUSTOMER',
          isCash: true,
          paidAmount: '3000',
          items: [
            { itemName: 'أرز بسمتي', quantity: 3, unitPrice: '1000', unit: 'كيس' },
          ],
        } as any,
        'business',
      );

      expect(order).toBeDefined();
      expect(new Decimal(order.total as any).toNumber()).toBe(3000);
      expect(new Decimal(order.paidAmount as any).toNumber()).toBe(3000);

      // Verify Database Transactions
      expect(mockDbTransactions.length).toBe(1); // EXACTLY 1 transaction (the Invoice)
      expect(mockDbTransactions[0].transactionType).toBe('SALE');
      expect(new Decimal(mockDbTransactions[0].amount).toNumber()).toBe(3000);
      expect(mockDbTransactions[0].orderId).toBe(order.id);

      // Verify NO Receipt Voucher (PAYMENT) was created
      const paymentTxns = mockDbTransactions.filter((t) => t.transactionType === 'PAYMENT');
      expect(paymentTxns.length).toBe(0);

      // Verify Account Balance impact = 0
      expect(mockAccount.balance.toNumber()).toBe(0);
      expect(mockAccount.totalDebit.toNumber()).toBe(0);
    });

    it('TEST 2: Partial Invoice (Total = 4,500, Paid = 1,500) -> Balance Impact = +3,000, Auto Receipt = NONE', async () => {
      const order = await ordersService.createOrder(
        'merchant-biz-1',
        {
          receiverId: 'customer-biz-2',
          connectionId: 'conn-cust-1',
          accountRole: 'CUSTOMER',
          isCash: false,
          paidAmount: '1500',
          items: [
            { itemName: 'زيت طبخ', quantity: 3, unitPrice: '1500', unit: 'دبة' },
          ],
        } as any,
        'business',
      );

      expect(order).toBeDefined();
      expect(new Decimal(order.total as any).toNumber()).toBe(4500);
      expect(new Decimal(order.paidAmount as any).toNumber()).toBe(1500);

      // Verify Database Transactions
      expect(mockDbTransactions.length).toBe(1); // EXACTLY 1 transaction (the Invoice)
      expect(mockDbTransactions[0].transactionType).toBe('SALE');
      expect(new Decimal(mockDbTransactions[0].amount).toNumber()).toBe(4500);

      // Verify NO Receipt Voucher (PAYMENT) was created
      const paymentTxns = mockDbTransactions.filter((t) => t.transactionType === 'PAYMENT');
      expect(paymentTxns.length).toBe(0);

      // Verify Account Balance impact = +3,000 (Remaining amount only)
      expect(mockAccount.balance.toNumber()).toBe(3000);
      expect(mockAccount.totalDebit.toNumber()).toBe(3000);
    });

    it('TEST 3: Credit Invoice (Total = 5,000, Paid = 0) -> Balance Impact = +5,000, Auto Receipt = NONE', async () => {
      const order = await ordersService.createOrder(
        'merchant-biz-1',
        {
          receiverId: 'customer-biz-2',
          connectionId: 'conn-cust-1',
          accountRole: 'CUSTOMER',
          isCash: false,
          paidAmount: '0',
          items: [
            { itemName: 'سكر برازيلي', quantity: 5, unitPrice: '1000', unit: 'شوال' },
          ],
        } as any,
        'business',
      );

      expect(order).toBeDefined();
      expect(new Decimal(order.total as any).toNumber()).toBe(5000);
      expect(new Decimal(order.paidAmount as any).toNumber()).toBe(0);

      // Verify Database Transactions
      expect(mockDbTransactions.length).toBe(1);
      expect(mockDbTransactions[0].transactionType).toBe('SALE');
      expect(new Decimal(mockDbTransactions[0].amount).toNumber()).toBe(5000);

      // Verify NO Receipt Voucher
      const paymentTxns = mockDbTransactions.filter((t) => t.transactionType === 'PAYMENT');
      expect(paymentTxns.length).toBe(0);

      // Verify Account Balance impact = +5,000
      expect(mockAccount.balance.toNumber()).toBe(5000);
      expect(mockAccount.totalDebit.toNumber()).toBe(5000);
    });

    it('TEST 4: Manual Receipt Voucher (Independent PAYMENT) -> Creates Voucher and Decreases Balance', async () => {
      // First, create credit invoice for 5,000 -> Balance becomes +5,000
      await ordersService.createOrder(
        'merchant-biz-1',
        {
          receiverId: 'customer-biz-2',
          connectionId: 'conn-cust-1',
          accountRole: 'CUSTOMER',
          isCash: false,
          paidAmount: '0',
          items: [{ itemName: 'بضاعة', quantity: 1, unitPrice: '5000', unit: 'حبة' }],
        } as any,
        'business',
      );
      expect(mockAccount.balance.toNumber()).toBe(5000);

      // Now create a manual Receipt Voucher (سند قبض يدوي) for 2,000
      await financeService.recordFinancialMovement(prisma, {
        senderId: 'customer-biz-2',
        receiverId: 'merchant-biz-1',
        amount: '2000',
        type: 'PAYMENT',
        connectionId: 'conn-cust-1',
        note: 'سند قبض نقدي رقم 101',
      });

      // Total Transactions in DB = 2 (1 SALE + 1 manual PAYMENT)
      expect(mockDbTransactions.length).toBe(2);
      const manualPayment = mockDbTransactions.find((t) => t.type === 'PAYMENT' || t.transactionType === 'PAYMENT');
      expect(manualPayment).toBeDefined();
      expect(new Decimal(manualPayment.amount).toNumber()).toBe(2000);

      // Balance becomes 5,000 - 2,000 = 3,000
      expect(mockAccount.balance.toNumber()).toBe(3000);
      expect(mockAccount.totalDebit.toNumber()).toBe(3000);
    });

    it('TEST 5: Various values test (500, 1500, 10000, 100000) for Cash Invoices -> Balance impact is always 0', async () => {
      for (const amount of [500, 1500, 10000, 100000]) {
        mockDbTransactions = [];
        mockAccount.balance = new Decimal(0);

        const order = await ordersService.createOrder(
          'merchant-biz-1',
          {
            receiverId: 'customer-biz-2',
            connectionId: 'conn-cust-1',
            accountRole: 'CUSTOMER',
            isCash: true,
            paidAmount: amount.toString(),
            items: [{ itemName: 'صنف', quantity: 1, unitPrice: amount.toString(), unit: 'حبة' }],
          } as any,
          'business',
        );

        expect(mockDbTransactions.length).toBe(1);
        expect(mockDbTransactions[0].transactionType).toBe('SALE');
        expect(new Decimal(mockDbTransactions[0].amount).toNumber()).toBe(amount);

        const payments = mockDbTransactions.filter((t) => t.transactionType === 'PAYMENT');
        expect(payments.length).toBe(0);

        expect(mockAccount.balance.toNumber()).toBe(0);
      }
    });

    it('TEST 6: Rebuilding account balance produces exact match with ledger truth', async () => {
      // 1. Partial invoice: 10,000 with 3,000 paid -> Remaining 7,000
      await ordersService.createOrder(
        'merchant-biz-1',
        {
          receiverId: 'customer-biz-2',
          connectionId: 'conn-cust-1',
          accountRole: 'CUSTOMER',
          isCash: false,
          paidAmount: '3000',
          items: [{ itemName: 'صنف أ', quantity: 1, unitPrice: '10000', unit: 'حبة' }],
        } as any,
        'business',
      );

      // 2. Cash invoice: 2,500 with 2,500 paid -> Remaining 0
      await ordersService.createOrder(
        'merchant-biz-1',
        {
          receiverId: 'customer-biz-2',
          connectionId: 'conn-cust-1',
          accountRole: 'CUSTOMER',
          isCash: true,
          paidAmount: '2500',
          items: [{ itemName: 'صنف ب', quantity: 1, unitPrice: '2500', unit: 'حبة' }],
        } as any,
        'business',
      );

      // 3. Manual payment voucher: 2,000
      await financeService.recordFinancialMovement(prisma, {
        senderId: 'customer-biz-2',
        receiverId: 'merchant-biz-1',
        amount: '2000',
        type: 'PAYMENT',
        connectionId: 'conn-cust-1',
        note: 'سند قبض نقدي',
      });

      // Current balance = 7,000 - 2,000 = 5,000
      expect(mockAccount.balance.toNumber()).toBe(5000);

      // Rebuild balance from transactions
      await financeService.rebuildAccountBalance('acc-cust-1');

      // Rebuilt balance MUST still be exactly 5,000
      expect(mockAccount.balance.toNumber()).toBe(5000);
    });
  });
});
