import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { PrismaService } from '../database/prisma.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { InvoiceNumberService } from '../common/invoice-number.service';
import { Decimal } from 'decimal.js';

describe('Order to Invoice Conversion & Relation Integrity (Regression Tests)', () => {
  let ordersService: OrdersService;
  let prisma: PrismaService;

  const mockPrismaService = {
    $transaction: jest.fn(async (cb) => {
      if (typeof cb === 'function') {
        return cb(mockPrismaService);
      }
      return cb;
    }),
    $executeRaw: jest.fn().mockResolvedValue(1),
    order: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    transaction: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    connection: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    business: {
      findUnique: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  };

  const mockFinanceService = {
    recordFinancialMovement: jest.fn(),
    rebuildAccountBalance: jest.fn(),
  };

  const mockNotificationsService = {
    sendPushNotification: jest.fn(),
  };

  const mockEventsGateway = {
    emitToBusiness: jest.fn(),
  };

  const mockInvoiceNumberService = {
    getNextInvoiceNumber: jest.fn().mockResolvedValue('INV-1001'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: FinanceService, useValue: mockFinanceService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
        { provide: InvoiceNumberService, useValue: mockInvoiceNumberService },
      ],
    }).compile();

    ordersService = module.get<OrdersService>(OrdersService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('TEST 1: Converting Order to Invoice maintains two-way relationship (Order.invoiceId = Txn.id, Txn.orderId = Order.id)', async () => {
    const orderId = 'order-uuid-76';
    const transactionId = 'txn-uuid-sale-76';

    const rawOrder = {
      id: orderId,
      orderNumber: '76',
      senderId: 'buyer-biz-1',
      receiverId: 'seller-biz-1',
      status: 'PRICED',
      pricesVisible: true,
      priceAcceptedAt: new Date(),
      isCash: false,
      total: '2500.00',
      paidAmount: '0.00',
      currency: 'YER',
      items: [
        {
          id: 'item-1',
          itemName: 'ش.ص',
          quantity: 1,
          unitPrice: '2500.00',
          total: '2500.00',
          unit: 'كرتون',
        },
      ],
    };

    mockPrismaService.order.findUnique.mockResolvedValue(rawOrder);
    mockPrismaService.connection.findFirst.mockResolvedValue({
      id: 'conn-1',
      requesterId: 'buyer-biz-1',
      receiverId: 'seller-biz-1',
      account: {
        totalDebit: '0.00',
        creditLimit: '50000.00',
      },
    });

    // No existing invoice before acceptance
    mockPrismaService.transaction.findFirst.mockResolvedValue(null);

    mockFinanceService.recordFinancialMovement.mockResolvedValue({
      transaction: {
        id: transactionId,
        voucherNumber: 'INV-1787164230606-3429',
        orderId: orderId,
        amount: new Decimal('2500.00'),
        transactionType: 'SALE',
      },
    });

    mockPrismaService.order.update.mockImplementation(({ where, data }) => {
      return {
        ...rawOrder,
        ...data,
      };
    });

    mockPrismaService.business.findUnique.mockResolvedValue({
      id: 'buyer-biz-1',
      user: { id: 'user-buyer-1' },
    });

    await ordersService.updateOrderStatus(
      'seller-biz-1',
      orderId,
      { status: 'ACCEPTED' },
      'business',
    );

    // Verify Financial Movement recorded with exact order.id
    expect(mockFinanceService.recordFinancialMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: orderId,
        senderId: 'seller-biz-1',
        receiverId: 'buyer-biz-1',
        type: 'SALE',
        amount: '2500.00',
      }),
    );

    // Verify order updated with invoiceId = transactionId
    expect(mockPrismaService.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: orderId },
        data: expect.objectContaining({
          invoiceId: transactionId,
        }),
      }),
    );
  });

  it('TEST 2: Idempotent conversion — accepting already accepted order does NOT create duplicate Transaction or Order', async () => {
    const orderId = 'order-uuid-76';
    const existingTransactionId = 'txn-uuid-sale-76';

    const acceptedOrder = {
      id: orderId,
      orderNumber: '76',
      senderId: 'buyer-biz-1',
      receiverId: 'seller-biz-1',
      status: 'ACCEPTED',
      pricesVisible: true,
      priceAcceptedAt: new Date(),
      isCash: false,
      total: '2500.00',
      paidAmount: '0.00',
      currency: 'YER',
      invoiceId: existingTransactionId,
      items: [],
    };

    mockPrismaService.order.findUnique.mockResolvedValue(acceptedOrder);
    mockPrismaService.connection.findFirst.mockResolvedValue({
      id: 'conn-1',
      requesterId: 'buyer-biz-1',
      receiverId: 'seller-biz-1',
      account: { totalDebit: '2500.00', creditLimit: '50000.00' },
    });

    // An existing SALE transaction is found!
    mockPrismaService.transaction.findFirst.mockResolvedValue({
      id: existingTransactionId,
      voucherNumber: 'INV-1787164230606-3429',
      orderId: orderId,
      amount: new Decimal('2500.00'),
    });

    mockPrismaService.business.findUnique.mockResolvedValue({
      id: 'buyer-biz-1',
      user: { id: 'user-buyer-1' },
    });

    await ordersService.updateOrderStatus(
      'seller-biz-1',
      orderId,
      { status: 'ACCEPTED' },
      'business',
    );

    // FinanceService must NOT record a second financial movement!
    expect(mockFinanceService.recordFinancialMovement).not.toHaveBeenCalled();
  });
});
