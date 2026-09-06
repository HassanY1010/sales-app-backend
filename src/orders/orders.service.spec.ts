import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { PrismaService } from '../database/prisma.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { InvoiceNumberService } from '../common/invoice-number.service';
import { Decimal } from 'decimal.js';

// ====================================================================
// Mock helpers
// ====================================================================
const mockPrisma = {
  connection: { findFirst: jest.fn() },
  customerSupplierLink: { findFirst: jest.fn() },
  account: { create: jest.fn(), findUnique: jest.fn() },
  business: { findUnique: jest.fn(), findFirst: jest.fn() },
  order: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  orderItem: { update: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(),
  $executeRaw: jest.fn(),
};

const mockFinanceService = { recordFinancialMovement: jest.fn() };
const mockNotificationsService = { sendPushNotification: jest.fn() };
const mockEventsGateway = { emitToBusiness: jest.fn() };
const mockInvoiceNumberService = {
  getNextInvoiceNumber: jest.fn().mockResolvedValue('INV-1001'),
  getNextOrderNumber: jest.fn().mockResolvedValue('ORD-1001'),
  generateInvoiceNumber: jest.fn().mockResolvedValue('INV-1001'),
};

// ====================================================================
// Test Suite
// ====================================================================
describe('OrdersService', () => {
  let service: OrdersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: FinanceService, useValue: mockFinanceService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
        { provide: InvoiceNumberService, useValue: mockInvoiceNumberService },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);

    // Reset all mocks between tests
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (callback: any) => callback(mockPrisma));
  });

  // ----------------------------------------------------------------
  // createOrder
  // ----------------------------------------------------------------
  describe('createOrder', () => {
    it('should throw if sender equals receiver', async () => {
      await expect(
        service.createOrder(
          'biz-1',
          { receiverId: 'biz-1', items: [] } as any,
          'business',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if no accepted connection exists', async () => {
      mockPrisma.connection.findFirst.mockResolvedValue(null);
      await expect(
        service.createOrder(
          'biz-1',
          { receiverId: 'biz-2', items: [] } as any,
          'business',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if credit limit would be exceeded (pricesVisible=true, non-cash)', async () => {
      mockPrisma.connection.findFirst.mockResolvedValue({
        id: 'conn-1',
        requesterId: 'biz-1',
        receiverId: 'biz-2',
        status: 'ACCEPTED',
        showPrices: true,
        account: {
          id: 'acc-1',
          totalDebit: new Decimal('900'),
          creditLimit: new Decimal('1000'),
          currency: 'YER',
          dueDate: null,
        },
      });
      mockPrisma.business.findUnique.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        name: `Business ${where.id}`,
        user: { id: `user-${where.id}`, userType: 'business' },
      }));

      await expect(
        service.createOrder(
          'biz-1',
          {
            receiverId: 'biz-2',
            isCash: false,
            items: [{ productName: 'Test', quantity: 1, unitPrice: '200' }],
          } as any,
          'business',
        ),
      ).rejects.toThrow(/سقف المديونية/);
    });

    it('should throw ForbiddenException if consumer sends to another consumer', async () => {
      mockPrisma.connection.findFirst.mockResolvedValue({
        id: 'conn-1',
        requesterId: 'biz-1',
        receiverId: 'biz-2',
        status: 'ACCEPTED',
        showPrices: false,
        account: {
          id: 'acc-1',
          totalDebit: 0,
          creditLimit: 1000,
          currency: 'YER',
          dueDate: null,
        },
      });
      mockPrisma.business.findUnique.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        name: `Consumer ${where.id}`,
        user: { id: `user-${where.id}`, userType: 'individual' },
      }));

      await expect(
        service.createOrder(
          'biz-1',
          { receiverId: 'biz-2', items: [] } as any,
          'individual',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should create order when connection is ACCEPTED and account exists in reverse direction B -> A', async () => {
      mockPrisma.connection.findFirst.mockResolvedValue({
        id: 'conn-1',
        requesterId: 'biz-2',
        receiverId: 'biz-1',
        status: 'ACCEPTED',
        showPrices: true,
        account: {
          id: 'acc-1',
          totalDebit: new Decimal('0'),
          creditLimit: new Decimal('100000'),
          currency: 'YER',
        },
      });
      mockPrisma.business.findUnique.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        name: `Biz ${where.id}`,
        user: { id: `user-${where.id}`, userType: 'business' },
      }));
      mockInvoiceNumberService.generateInvoiceNumber.mockResolvedValue('INV-999');
      mockPrisma.order.create.mockResolvedValue({
        id: 'ord-100',
        orderNumber: 'INV-999',
        senderId: 'biz-1',
        receiverId: 'biz-2',
        connectionId: 'conn-1',
        status: 'PENDING',
        items: [],
      });

      const result = await service.createOrder(
        'biz-1',
        { receiverId: 'biz-2', items: [] } as any,
        'business',
      );

      expect(result.id).toBe('ord-100');
      expect(mockPrisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            senderId: 'biz-1',
            receiverId: 'biz-2',
            connectionId: 'conn-1',
          }),
        }),
      );
    });

    it('should auto-create standard Account when ACCEPTED connection is missing an account', async () => {
      mockPrisma.connection.findFirst.mockResolvedValue({
        id: 'conn-no-acc',
        requesterId: 'biz-1',
        receiverId: 'biz-2',
        status: 'ACCEPTED',
        showPrices: true,
        account: null,
      });
      mockPrisma.account.create.mockResolvedValue({
        id: 'acc-new',
        connectionId: 'conn-no-acc',
        balance: 0,
        totalCredit: 0,
        totalDebit: 0,
        creditLimit: 100000,
        currency: 'YER',
      });
      mockPrisma.business.findUnique.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        name: `Biz ${where.id}`,
        user: { id: `user-${where.id}`, userType: 'business' },
      }));
      mockInvoiceNumberService.generateInvoiceNumber.mockResolvedValue('INV-1000');
      mockPrisma.order.create.mockResolvedValue({
        id: 'ord-200',
        orderNumber: 'INV-1000',
        senderId: 'biz-1',
        receiverId: 'biz-2',
        connectionId: 'conn-no-acc',
        status: 'PENDING',
        items: [],
      });

      const result = await service.createOrder(
        'biz-1',
        { receiverId: 'biz-2', items: [] } as any,
        'business',
      );

      expect(mockPrisma.account.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          connectionId: 'conn-no-acc',
          creditLimit: 100000,
          currency: 'YER',
        }),
      });
      expect(result.id).toBe('ord-200');
    });
  });

  // ----------------------------------------------------------------
  // updateOrderStatus
  // ----------------------------------------------------------------
  describe('updateOrderStatus', () => {
    it('should throw NotFoundException for unknown order', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      await expect(
        service.updateOrderStatus(
          'biz-1',
          'order-999',
          { status: 'ACCEPTED' } as any,
          'business',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if unrelated business tries to act', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        senderId: 'biz-A',
        receiverId: 'biz-B',
        status: 'PENDING',
        pricesVisible: true,
        isCash: false,
        total: '100',
        items: [],
      });
      await expect(
        service.updateOrderStatus(
          'biz-X',
          'order-1',
          { status: 'ACCEPTED' } as any,
          'business',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when accepting without prices', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        senderId: 'biz-A',
        receiverId: 'biz-B',
        status: 'PENDING',
        pricesVisible: false, // ← prices not set yet
        isCash: false,
        total: '0',
        items: [],
      });
      await expect(
        service.updateOrderStatus(
          'biz-B',
          'order-1',
          { status: 'ACCEPTED' } as any,
          'business',
        ),
      ).rejects.toThrow(/اعتماد الأسعار/);
    });

    it('should throw BadRequestException when rejecting without reason', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        senderId: 'biz-A',
        receiverId: 'biz-B',
        status: 'PENDING',
        pricesVisible: true,
        isCash: false,
        total: '100',
        items: [],
      });
      await expect(
        service.updateOrderStatus(
          'biz-B',
          'order-1',
          { status: 'REJECTED' } as any,
          'business',
        ),
      ).rejects.toThrow(/سبب الرفض/);
    });

    it('should reject order automatically with REJECTED status when ACCEPTED order would exceed credit limit', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        senderId: 'biz-A',
        receiverId: 'biz-B',
        status: 'PENDING',
        pricesVisible: true,
        isCash: false,
        total: '600', // ← total that would exceed limit
        orderNumber: 'ORD-001',
        currency: 'YER',
        dueDate: null,
        items: [],
      });

      mockPrisma.order.update.mockResolvedValue({
        id: 'order-1',
        senderId: 'biz-A',
        receiverId: 'biz-B',
        status: 'REJECTED',
        rejectionReason: 'Credit Limit Exceeded',
        rejectedById: 'biz-B',
        orderNumber: 'ORD-001',
        total: '600',
        currency: 'YER',
        items: [],
      });

      // Mock $transaction to run the callback
      mockPrisma.$transaction.mockImplementation(async (callback: any) => {
        const txClient = {
          ...mockPrisma,
          connection: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'conn-1',
              requesterId: 'biz-A',
              receiverId: 'biz-B',
              status: 'ACCEPTED',
              account: {
                id: 'acc-1',
                totalDebit: new Decimal('500'), // already at 500
                creditLimit: new Decimal('1000'), // limit is 1000
              },
            }),
          },
          order: { update: jest.fn() },
          $executeRaw: jest.fn().mockResolvedValue(null),
        };
        return callback(txClient);
      });

      const result = await service.updateOrderStatus(
        'biz-B',
        'order-1',
        { status: 'ACCEPTED' } as any,
        'business',
      );

      expect(result?.status).toBe('REJECTED');
      expect(result?.rejectionReason).toBe('Credit Limit Exceeded');
    });
  });

  // ----------------------------------------------------------------
  // getOrderById
  // ----------------------------------------------------------------
  describe('getOrderById', () => {
    it('should throw NotFoundException for non-existent order', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      await expect(service.getOrderById('biz-1', 'order-X')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException if business is not party to the order', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        senderId: 'biz-A',
        receiverId: 'biz-B',
        pricesVisible: true,
        status: 'PENDING',
        items: [],
      });
      await expect(service.getOrderById('biz-X', 'order-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ----------------------------------------------------------------
  // Incoming Orders & Notification Separation Suite
  // ----------------------------------------------------------------
  describe('Incoming Orders & Notification Separation', () => {
    it('should set status to PENDING and NOT create general notification DB record when purchase order sent to supplier without prices', async () => {
      mockPrisma.connection.findFirst.mockResolvedValue({
        id: 'conn-1',
        requesterId: 'cust-1',
        receiverId: 'supp-1',
        status: 'ACCEPTED',
        showPrices: false,
        account: {
          id: 'acc-1',
          totalDebit: new Decimal('0'),
          creditLimit: new Decimal('100000'),
          currency: 'YER',
        },
      });
      mockPrisma.business.findUnique.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        name: `Biz ${where.id}`,
        user: { id: `user-${where.id}`, userType: 'business' },
      }));
      mockInvoiceNumberService.getNextInvoiceNumber.mockResolvedValue('ORD-555');
      mockPrisma.order.create.mockResolvedValue({
        id: 'ord-555',
        orderNumber: 'ORD-555',
        senderId: 'cust-1',
        receiverId: 'supp-1',
        connectionId: 'conn-1',
        status: 'PENDING',
        pricesVisible: false,
        items: [{ id: 'item-1', productName: 'Item A', quantity: 5, unitPrice: '0', total: '0' }],
      });

      const result = await service.createOrder(
        'cust-1',
        {
          receiverId: 'supp-1',
          pricesVisible: false,
          items: [{ productName: 'Item A', quantity: 5, unitPrice: '0' }],
        } as any,
        'business',
      );

      expect(result.status).toBe('PENDING');
      expect(mockPrisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PENDING',
            pricesVisible: false,
          }),
        }),
      );
      // Ensure push notification is NOT called for PENDING purchase order (preventing duplicate general notification)
      expect(mockNotificationsService.sendPushNotification).not.toHaveBeenCalled();
      // Realtime event emitted
      expect(mockEventsGateway.emitToBusiness).toHaveBeenCalledWith('supp-1', 'NEW_ORDER', expect.any(Object));
    });

    it('should return existing order on duplicate clientId (idempotency)', async () => {
      const existingOrder = {
        id: 'ord-existing',
        clientId: 'device-uuid-123',
        status: 'PENDING',
        senderId: 'cust-1',
        receiverId: 'supp-1',
        items: [],
      };
      mockPrisma.order.findUnique.mockResolvedValue(existingOrder);

      const result = await service.createOrder(
        'cust-1',
        {
          clientId: 'device-uuid-123',
          receiverId: 'supp-1',
          items: [],
        } as any,
        'business',
      );

      expect(result).toEqual(existingOrder);
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });

    it('should allow supplier to update prices on PENDING order and save prices correctly', async () => {
      const pendingOrder = {
        id: 'ord-pending',
        status: 'PENDING',
        senderId: 'cust-1',
        receiverId: 'supp-1',
        currency: 'YER',
        total: '0',
        paidAmount: '0',
        items: [{ id: 'item-1', quantity: 2, unitPrice: '0' }],
      };
      mockPrisma.order.findUnique.mockResolvedValue(pendingOrder);
      mockPrisma.orderItem.update.mockResolvedValue({ id: 'item-1', unitPrice: '500', total: '1000' });
      mockPrisma.order.update.mockResolvedValue({
        ...pendingOrder,
        subtotal: '1000',
        total: '1000',
        pricesVisible: true,
      });

      const updated = await service.updateOrderPrices(
        'supp-1',
        'ord-pending',
        {
          items: [{ id: 'item-1', unitPrice: '500' }],
        } as any,
        'business',
      );

      expect(mockPrisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { unitPrice: '500', total: '1000' },
      });
      expect(mockPrisma.order.update).toHaveBeenCalledWith({
        where: { id: 'ord-pending' },
        data: expect.objectContaining({
          subtotal: '1000',
          total: '1000',
          pricesVisible: true,
        }),
      });
    });

    it('should allow merchant (sender) to edit prices on ISSUED invoice and recalculate totals', async () => {
      const issuedInvoice = {
        id: 'inv-26',
        orderNumber: '26',
        status: 'ISSUED',
        senderId: 'biz-hr',
        receiverId: 'biz-client',
        currency: 'YER',
        total: '1300',
        paidAmount: '0',
        items: [
          { id: 'item-1', itemName: 'ماء شملان', quantity: 1, unitPrice: '100', total: '100' },
          { id: 'item-2', itemName: 'رز', quantity: 1, unitPrice: '1000', total: '1000' },
          { id: 'item-3', itemName: 'كيك', quantity: 1, unitPrice: '200', total: '200' },
        ],
      };
      mockPrisma.order.findUnique.mockResolvedValue(issuedInvoice);
      mockPrisma.orderItem.update.mockResolvedValue({ id: 'item-1', unitPrice: '150', total: '150' });
      mockPrisma.order.update.mockResolvedValue({
        ...issuedInvoice,
        subtotal: '1350',
        total: '1350',
      });

      const updated = await service.updateOrderPrices(
        'biz-hr',
        'inv-26',
        {
          items: [
            { id: 'item-1', unitPrice: '150' },
            { id: 'item-2', unitPrice: '1000' },
            { id: 'item-3', unitPrice: '200' },
          ],
        } as any,
        'business',
      );

      expect(mockPrisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { unitPrice: '150', total: '150' },
      });
      expect(mockPrisma.order.update).toHaveBeenCalledWith({
        where: { id: 'inv-26' },
        data: expect.objectContaining({
          subtotal: '1350',
          total: '1350',
        }),
      });
    });

    it('should reject editing prices on REJECTED or CANCELLED orders with BadRequestException', async () => {
      const rejectedOrder = {
        id: 'ord-rej',
        status: 'REJECTED',
        senderId: 'biz-1',
        receiverId: 'biz-2',
        items: [],
      };
      mockPrisma.order.findUnique.mockResolvedValue(rejectedOrder);

      await expect(
        service.updateOrderPrices(
          'biz-2',
          'ord-rej',
          { items: [] } as any,
          'business',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject item ID not belonging to order with BadRequestException', async () => {
      const order = {
        id: 'ord-10',
        status: 'PENDING',
        senderId: 'biz-1',
        receiverId: 'biz-2',
        items: [{ id: 'item-legit', quantity: 1, unitPrice: '100' }],
      };
      mockPrisma.order.findUnique.mockResolvedValue(order);

      await expect(
        service.updateOrderPrices(
          'biz-2',
          'ord-10',
          { items: [{ id: 'item-from-other-order', unitPrice: '500' }] } as any,
          'business',
        ),
      ).rejects.toThrow(/لا ينتمي إلى هذه الطلبية/);
    });

    it('should reject third-party user C with ForbiddenException', async () => {
      const order = {
        id: 'ord-10',
        status: 'PENDING',
        senderId: 'biz-1',
        receiverId: 'biz-2',
        items: [{ id: 'item-1', quantity: 1, unitPrice: '100' }],
      };
      mockPrisma.order.findUnique.mockResolvedValue(order);

      await expect(
        service.updateOrderPrices(
          'biz-intruder-3',
          'ord-10',
          { items: [{ id: 'item-1', unitPrice: '500' }] } as any,
          'business',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should NOT create financial movement if totalDiff and paidDiff are zero on repeated save', async () => {
      const invoice = {
        id: 'inv-100',
        orderNumber: 'INV-100',
        status: 'ACCEPTED',
        invoiceId: 'tx-100',
        senderId: 'biz-1',
        receiverId: 'biz-2',
        total: '500',
        paidAmount: '0',
        items: [{ id: 'item-1', quantity: 1, unitPrice: '500', total: '500' }],
      };
      mockPrisma.order.findUnique.mockResolvedValue(invoice);
      mockPrisma.connection.findFirst.mockResolvedValue({ id: 'conn-1', account: { id: 'acc-1' } });

      await service.updateOrderPrices(
        'biz-1',
        'inv-100',
        { items: [{ id: 'item-1', unitPrice: '500' }] } as any,
        'business',
      );

      // No financial movements because totalDiff is 0
      expect(mockFinanceService.recordFinancialMovement).not.toHaveBeenCalled();
    });

    it('should include "المورد [اسم المورد]" in push notification sent to customer on direct sales invoice creation', async () => {
      mockPrisma.connection.findFirst.mockResolvedValue({
        id: 'conn-supp-cust',
        requesterId: 'supp-sanaa',
        receiverId: 'cust-barakah',
        status: 'ACCEPTED',
        showPrices: true,
        account: {
          id: 'acc-1',
          totalDebit: new Decimal('0'),
          creditLimit: new Decimal('100000'),
          currency: 'YER',
        },
      });
      mockPrisma.business.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.id === 'supp-sanaa') {
          return { id: 'supp-sanaa', name: 'بقالة صنعاء', user: { id: 'user-supp', userType: 'business' } };
        }
        return { id: 'cust-barakah', name: 'سوبرماركت البركة', user: { id: 'user-cust', userType: 'business' } };
      });
      mockInvoiceNumberService.getNextInvoiceNumber.mockResolvedValue('INV-9901');
      mockPrisma.order.create.mockResolvedValue({
        id: 'ord-inv-9901',
        orderNumber: 'INV-9901',
        senderId: 'supp-sanaa',
        receiverId: 'cust-barakah',
        connectionId: 'conn-supp-cust',
        status: 'ISSUED',
        pricesVisible: true,
        total: '1500',
        items: [{ id: 'item-1', itemName: 'حده كبيو', quantity: 1, unitPrice: '1500', total: '1500' }],
      });

      await service.createOrder(
        'supp-sanaa',
        {
          receiverId: 'cust-barakah',
          isCash: false,
          notes: 'طلب مبيعات من التطبيق',
          items: [{ itemName: 'حده كبيو', quantity: 1, unitPrice: '1500', total: '1500' }],
        } as any,
        'business',
      );

      // Verify push notification sent to customer contains "المورد بقالة صنعاء"
      expect(mockNotificationsService.sendPushNotification).toHaveBeenCalledWith(
        'user-cust',
        'فاتورة جديدة',
        expect.stringContaining('من المورد بقالة صنعاء'),
        expect.objectContaining({ type: 'NEW_ORDER' }),
      );
    });
  });
});
