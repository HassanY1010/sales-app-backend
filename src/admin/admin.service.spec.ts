import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FinanceService } from '../finance/finance.service';

// ====================================================================
// Mock helpers
// ====================================================================
const mockPrisma = {
  user: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  business: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  order: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    aggregate: jest.fn(),
  },
  transaction: {
    findMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
  },
  account: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
  },
  connection: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  suggestion: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  adjustmentRequest: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  notification: {
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  auditLog: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  expense: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  refreshToken: {
    count: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  },
  adminAction: { create: jest.fn() },
  paymentRequest: { count: jest.fn() },
  systemSettings: { findMany: jest.fn(), upsert: jest.fn() },
  $queryRaw: jest.fn(),
};

const mockNotificationsService = {
  notifyUser: jest.fn(),
};

// ====================================================================
// Test Suite
// ====================================================================
describe('AdminService', () => {
  let service: AdminService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: FinanceService, useValue: { rebuildAccountBalance: jest.fn(), recordFinancialMovement: jest.fn() } },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
    jest.clearAllMocks();
  });

  // ----------------------------------------------------------------
  // updateSuggestionStatus — BUG-03 fix
  // ----------------------------------------------------------------
  describe('updateSuggestionStatus', () => {
    it('should throw BadRequestException for invalid status value (BUG-03 fix)', async () => {
      await expect(
        service.updateSuggestionStatus('suggestion-1', 'INVALID_STATUS'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for SQL-injection-like status', async () => {
      await expect(
        service.updateSuggestionStatus(
          'suggestion-1',
          "'; DROP TABLE suggestions; --",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if suggestion does not exist', async () => {
      mockPrisma.suggestion.findUnique.mockResolvedValue(null);
      await expect(
        service.updateSuggestionStatus('nonexistent-id', 'OPEN'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should update suggestion status when valid', async () => {
      const mockSuggestion = {
        id: 'suggestion-1',
        status: 'OPEN',
        content: 'test',
      };
      mockPrisma.suggestion.findUnique.mockResolvedValue(mockSuggestion);
      mockPrisma.suggestion.update.mockResolvedValue({
        ...mockSuggestion,
        status: 'REVIEWED',
      });

      const result = await service.updateSuggestionStatus(
        'suggestion-1',
        'REVIEWED',
      );
      expect(result.status).toBe('REVIEWED');
      expect(mockPrisma.suggestion.update).toHaveBeenCalledWith({
        where: { id: 'suggestion-1' },
        data: { status: 'REVIEWED' },
      });
    });

    it.each(['OPEN', 'REVIEWED', 'CLOSED'])(
      'should accept valid status: %s',
      async (validStatus) => {
        const mockSuggestion = { id: 'suggestion-1', status: 'OPEN' };
        mockPrisma.suggestion.findUnique.mockResolvedValue(mockSuggestion);
        mockPrisma.suggestion.update.mockResolvedValue({
          ...mockSuggestion,
          status: validStatus,
        });
        await expect(
          service.updateSuggestionStatus('suggestion-1', validStatus),
        ).resolves.not.toThrow();
      },
    );
  });

  // ----------------------------------------------------------------
  // getFinancialReport — BUG-04 fix (uses aggregate, not findMany)
  // ----------------------------------------------------------------
  describe('getFinancialReport', () => {
    it('should use aggregate queries instead of findMany (BUG-04 fix)', async () => {
      mockPrisma.transaction.aggregate.mockResolvedValue({
        _sum: { amount: '5000' },
        _count: { id: 42 },
      });
      mockPrisma.order.aggregate.mockResolvedValue({
        _sum: { total: '12000' },
        _count: { id: 30 },
      });
      mockPrisma.account.aggregate.mockResolvedValue({
        _sum: { totalDebit: '3000', totalCredit: '1500' },
      });

      const result = await service.getFinancialReport();

      // Verify aggregate was called, NOT findMany
      expect(mockPrisma.transaction.aggregate).toHaveBeenCalled();
      expect(mockPrisma.order.aggregate).toHaveBeenCalled();
      expect(mockPrisma.account.aggregate).toHaveBeenCalled();
      expect(mockPrisma.transaction.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.order.findMany).not.toHaveBeenCalled();

      expect(result).toMatchObject({
        totalRevenue: '5000',
        totalOrderValue: '12000',
        totalReceivable: '3000',
        totalPayable: '1500',
        netBalance: '1500',
        transactionCount: 42,
        orderCount: 30,
      });
    });

    it('should handle null aggregate sums gracefully', async () => {
      mockPrisma.transaction.aggregate.mockResolvedValue({
        _sum: { amount: null },
        _count: { id: 0 },
      });
      mockPrisma.order.aggregate.mockResolvedValue({
        _sum: { total: null },
        _count: { id: 0 },
      });
      mockPrisma.account.aggregate.mockResolvedValue({
        _sum: { totalDebit: null, totalCredit: null },
      });

      const result = await service.getFinancialReport();
      expect(result.totalRevenue).toBe('0');
      expect(result.totalOrderValue).toBe('0');
      expect(result.netBalance).toBe('0');
    });
  });

  // ----------------------------------------------------------------
  // toggleUserStatus
  // ----------------------------------------------------------------
  describe('toggleUserStatus', () => {
    it('should throw NotFoundException for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.toggleUserStatus(
          { userId: 'nonexistent', isActive: false },
          'admin-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should update user status and log the action', async () => {
      const mockUser = { id: 'user-1', isActive: true, fullName: 'Test User' };
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.user.update.mockResolvedValue({
        ...mockUser,
        isActive: false,
      });
      mockPrisma.adminAction.create.mockResolvedValue({});

      await service.toggleUserStatus(
        { userId: 'user-1', isActive: false },
        'admin-1',
      );

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { isActive: false },
      });
      expect(mockPrisma.adminAction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'TOGGLE_USER_STATUS',
            adminId: 'admin-1',
          }),
        }),
      );
    });
  });

  // ----------------------------------------------------------------
  // rejectAdjustmentRequest
  // ----------------------------------------------------------------
  describe('rejectAdjustmentRequest', () => {
    it('should throw BadRequestException if rejection reason is too short', async () => {
      await expect(
        service.rejectAdjustmentRequest('req-1', 'ab', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException for non-existent request', async () => {
      mockPrisma.adjustmentRequest.findUnique.mockResolvedValue(null);
      await expect(
        service.rejectAdjustmentRequest(
          'nonexistent',
          'Valid reason here',
          'admin-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for already processed request', async () => {
      mockPrisma.adjustmentRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'APPROVED',
        targetType: 'INVOICE',
        targetId: 'inv-1',
      });
      await expect(
        service.rejectAdjustmentRequest(
          'req-1',
          'Valid reason here',
          'admin-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
