import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConnectionsService } from './connections.service';

describe('ConnectionsService - Relationship Requests & Edge Cases', () => {
  function createService() {
    const prisma: any = {
      $transaction: jest.fn((cb: any) => cb(prisma)),
      business: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      user: {
        findFirst: jest.fn(),
      },
      connection: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      account: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
    };

    const notificationsService = {
      sendPushNotification: jest.fn().mockResolvedValue(true),
    };

    const eventsGateway = {
      emitToBusiness: jest.fn(),
    };

    const financeService = {
      recordFinancialMovement: jest.fn(),
      rebuildAccountBalance: jest.fn(),
    };

    const service = new ConnectionsService(
      prisma as any,
      notificationsService as any,
      eventsGateway as any,
      financeService as any,
    );

    return { prisma, notificationsService, eventsGateway, financeService, service };
  }

  describe('Point 1 & 2: Sending Relationship Requests & DB Unique Protection', () => {
    it('prevents self-linking when phone belongs to current business', async () => {
      const { prisma, service } = createService();
      prisma.business.findUnique.mockResolvedValue({
        id: 'biz-sender',
        phoneNumber: '777123456',
      });

      await expect(
        service.sendRelationshipRequestByPhone('biz-sender', 'user-sender', {
          phoneNumber: '+967777123456',
          connectionType: 'CUSTOMER',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates a PENDING connection for an unregistered phone number without creating a shadow user', async () => {
      const { prisma, service } = createService();
      prisma.business.findUnique.mockResolvedValue({
        id: 'biz-sender',
        phoneNumber: '777111222',
      });
      prisma.business.findFirst.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.connection.findFirst.mockResolvedValue(null);
      prisma.connection.create.mockResolvedValue({
        id: 'conn-pending-1',
        requesterId: 'biz-sender',
        receiverPhone: '777333444',
        connectionType: 'CUSTOMER',
        status: 'PENDING',
      });

      const result = await service.sendRelationshipRequestByPhone('biz-sender', 'user-sender', {
        phoneNumber: '0777333444',
        connectionType: 'CUSTOMER',
        personalName: 'أحمد',
        businessName: 'بقالة الأمل',
        openingBalance: 5000,
        creditLimit: 50000,
      });

      expect(result.status).toBe('PENDING');
      expect(result.receiverPhone).toBe('777333444');
      expect(prisma.connection.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            requesterId: 'biz-sender',
            receiverPhone: '777333444',
            connectionType: 'CUSTOMER',
            status: 'PENDING',
            pendingName: 'أحمد',
            pendingBizName: 'بقالة الأمل',
            pendingOpenBalance: 5000,
            pendingCreditLimit: 50000,
            requiresReceiverInput: false,
          }),
        }),
      );
    });

    it('throws ConflictException on Prisma P2002 unique constraint error (Race Condition protection)', async () => {
      const { prisma, service } = createService();
      prisma.business.findUnique.mockResolvedValue({ id: 'biz-sender', phoneNumber: '777111222' });
      prisma.business.findFirst.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.connection.findFirst.mockResolvedValue(null);

      const p2002Error = new Error('Unique constraint failed') as any;
      p2002Error.code = 'P2002';
      prisma.connection.create.mockRejectedValue(p2002Error);

      await expect(
        service.sendRelationshipRequestByPhone('biz-sender', 'user-sender', {
          phoneNumber: '777333444',
          connectionType: 'CUSTOMER',
          personalName: 'أحمد',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Point 3 & 4: Multi-request Auto-linking & Phone Normalization', () => {
    it('migrates 3 pending requests for the same phone number independently upon registration without auto-accepting', async () => {
      const { prisma, notificationsService, service } = createService();
      const pendingRequests = [
        { id: 'conn-1', requesterId: 'biz-a', receiverPhone: '777888999', connectionType: 'CUSTOMER', requiresReceiverInput: false, requester: { name: 'متجر أ' } },
        { id: 'conn-2', requesterId: 'biz-b', receiverPhone: '777888999', connectionType: 'SUPPLIER', requiresReceiverInput: true, requester: { name: 'مورد ب' } },
        { id: 'conn-3', requesterId: 'biz-c', receiverPhone: '777888999', connectionType: 'CUSTOMER', requiresReceiverInput: false, requester: { name: 'متجر ج' } },
      ];

      prisma.connection.findMany.mockResolvedValue(pendingRequests);
      prisma.connection.findFirst.mockResolvedValue(null);
      prisma.connection.update.mockResolvedValue({});

      const count = await service.linkPendingRequestsAfterRegistration(
        '+967777888999',
        'biz-new-user',
        'user-new-user',
      );

      expect(count).toBe(3);
      expect(prisma.connection.update).toHaveBeenCalledWith({
        where: { id: 'conn-1' },
        data: { receiverId: 'biz-new-user', receiverPhone: null },
      });
      expect(prisma.connection.update).toHaveBeenCalledWith({
        where: { id: 'conn-2' },
        data: { receiverId: 'biz-new-user', receiverPhone: null },
      });
      expect(prisma.connection.update).toHaveBeenCalledWith({
        where: { id: 'conn-3' },
        data: { receiverId: 'biz-new-user', receiverPhone: null },
      });
      expect(notificationsService.sendPushNotification).toHaveBeenCalledTimes(3);
    });

    it('normalizes various phone formats (+967777123456, 00967777123456, 0777123456) to canonical digits 777123456', () => {
      const { service } = createService();
      expect(service.normalizePhoneNumber('+967777123456')).toBe('777123456');
      expect(service.normalizePhoneNumber('00967777123456')).toBe('777123456');
      expect(service.normalizePhoneNumber('967 777 123 456')).toBe('777123456');
      expect(service.normalizePhoneNumber('0777123456')).toBe('777123456');
      expect(service.normalizePhoneNumber('777123456')).toBe('777123456');
    });
  });

  describe('Point 5: Backend Financial Input Enforcement on Supplier Acceptance', () => {
    it('throws BadRequestException if receiver attempts to accept supplier request without providing financial terms', async () => {
      const { prisma, service } = createService();
      prisma.connection.findUnique.mockResolvedValue({
        id: 'conn-supplier-req',
        receiverId: 'biz-receiver',
        status: 'PENDING',
        requiresReceiverInput: true,
      });

      await expect(
        service.acceptConnection('biz-receiver', 'user-receiver', 'conn-supplier-req', {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts successfully when receiver provides valid financial terms for supplier request', async () => {
      const { prisma, notificationsService, service } = createService();
      const pendingConn = {
        id: 'conn-supplier-req',
        requesterId: 'biz-supplier',
        receiverId: 'biz-receiver',
        status: 'PENDING',
        connectionType: 'SUPPLIER',
        requiresReceiverInput: true,
        account: null,
      };

      prisma.connection.findUnique.mockResolvedValue(pendingConn);
      prisma.account.findUnique.mockResolvedValue(null);
      prisma.connection.update.mockResolvedValue({
        ...pendingConn,
        status: 'ACCEPTED',
        account: { id: 'acc-1', balance: 0 },
        requester: { name: 'المورد الشامل', user: { id: 'user-supplier' } },
        receiver: { name: 'متجر التجزئة' },
      });

      await service.acceptConnection('biz-receiver', 'user-receiver', 'conn-supplier-req', {
        openingBalance: 15000,
        creditLimit: 200000,
      });

      expect(prisma.connection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'ACCEPTED',
            account: expect.objectContaining({
              create: expect.objectContaining({
                balance: 0,
                creditLimit: 200000,
              }),
            }),
          }),
        }),
      );
      expect(notificationsService.sendPushNotification).toHaveBeenCalledWith(
        'user-supplier',
        'تم قبول طلب الارتباط',
        expect.stringContaining('متجر التجزئة'),
        expect.any(Object),
      );
    });
  });
});
