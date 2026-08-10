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
const mockInvoiceNumberService = { generateInvoiceNumber: jest.fn().mockResolvedValue('INV-1001') };

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
        showPrices: true,
        account: {
          id: 'acc-1',
          totalDebit: new Decimal('900'),
          creditLimit: new Decimal('1000'),
          currency: 'YER',
          dueDate: null,
        },
      });
      mockPrisma.business.findUnique.mockResolvedValue({
        id: 'biz-1',
        name: 'Business 1',
        user: { id: 'user-1', userType: 'business' },
      });

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
        showPrices: false,
        account: {
          id: 'acc-1',
          totalDebit: 0,
          creditLimit: 1000,
          currency: 'YER',
          dueDate: null,
        },
      });
      mockPrisma.business.findUnique.mockResolvedValue({
        id: 'biz-2',
        name: 'Consumer 2',
        user: { id: 'user-2', userType: 'individual' },
      });

      await expect(
        service.createOrder(
          'biz-1',
          { receiverId: 'biz-2', items: [] } as any,
          'individual',
        ),
      ).rejects.toThrow(ForbiddenException);
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
});
