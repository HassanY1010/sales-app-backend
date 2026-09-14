import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringService } from './monitoring.service';
import { PrismaService } from '../database/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';

describe('MonitoringService & Suggestions E2E Suite', () => {
  let service: MonitoringService;
  let prisma: typeof mockPrisma;
  let eventsGateway: typeof mockEventsGateway;
  let notificationsService: typeof mockNotificationsService;

  const mockPrisma = {
    suggestion: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
    auditLog: {
      findMany: jest.fn(),
    },
    business: {
      findUnique: jest.fn(),
    },
  };

  const mockEventsGateway = {
    server: {
      emit: jest.fn(),
    },
  };

  const mockNotificationsService = {
    notifyAdmins: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonitoringService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventsGateway, useValue: mockEventsGateway },
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    }).compile();

    service = module.get<MonitoringService>(MonitoringService);
    prisma = module.get(PrismaService);
    eventsGateway = module.get(EventsGateway);
    notificationsService = module.get(NotificationsService);
  });

  describe('createSuggestion (Complaint Creation & Notification Lifecycle)', () => {
    it('TEST 1: Creating first complaint successfully persists in DB and returns populated object', async () => {
      const mockCreated = {
        id: 'complaint-001',
        userId: 'user-001',
        content: 'أول شكوى: يوجد تأخر في استلام البضائع',
        whatsapp: '967770000000',
        status: 'OPEN',
        createdAt: new Date(),
        user: {
          id: 'user-001',
          fullName: 'تاجر الأمل',
          email: 'hope@trade.com',
          phoneNumber: '770000000',
          userType: 'business',
          business: { name: 'مؤسسة الأمل التجارية' },
        },
      };

      mockPrisma.suggestion.create.mockResolvedValue(mockCreated);
      mockNotificationsService.notifyAdmins.mockResolvedValue([]);

      const result = await service.createSuggestion(
        'user-001',
        'أول شكوى: يوجد تأخر في استلام البضائع',
        '967770000000',
      );

      expect(result).toBeDefined();
      expect(result.id).toBe('complaint-001');
      expect(result.content).toBe('أول شكوى: يوجد تأخر في استلام البضائع');
      expect(mockPrisma.suggestion.create).toHaveBeenCalledTimes(1);
    });

    it('TEST 2: First complaint creates a persistent notification for admins containing complaintId & explicit payload', async () => {
      const mockCreated = {
        id: 'complaint-001',
        userId: 'user-001',
        content: 'عطل في عملية المزامنة',
        whatsapp: '967771111111',
        status: 'OPEN',
        createdAt: new Date(),
        user: {
          id: 'user-001',
          fullName: 'سعيد صالح',
          phoneNumber: '771111111',
          userType: 'individual',
          business: null,
        },
      };

      mockPrisma.suggestion.create.mockResolvedValue(mockCreated);
      mockNotificationsService.notifyAdmins.mockResolvedValue([]);

      await service.createSuggestion('user-001', 'عطل في عملية المزامنة', '967771111111');

      // Verify that notifyAdmins is called with explicit entityId = complaintId
      expect(mockNotificationsService.notifyAdmins).toHaveBeenCalledWith(
        'شكوى/اقتراح جديد',
        expect.stringContaining('سعيد صالح'),
        expect.objectContaining({
          type: 'suggestion',
          entityType: 'suggestion',
          entityId: 'complaint-001',
          suggestionId: 'complaint-001',
          route: '/dashboard/suggestions?id=complaint-001',
        }),
      );

      // Verify realtime socket broadcast
      expect(mockEventsGateway.server.emit).toHaveBeenCalledWith(
        'admin-suggestion-created',
        mockCreated,
      );
    });

    it('TEST 8: Multiple sequential complaints each generate their own distinct notification and ID', async () => {
      const complaints = [
        { id: 'comp-1', content: 'Complaint 1' },
        { id: 'comp-2', content: 'Complaint 2' },
        { id: 'comp-3', content: 'Complaint 3' },
      ];

      for (const item of complaints) {
        mockPrisma.suggestion.create.mockResolvedValue({
          id: item.id,
          userId: 'user-1',
          content: item.content,
          whatsapp: null,
          status: 'OPEN',
          createdAt: new Date(),
          user: { fullName: 'User 1', userType: 'individual' },
        });

        await service.createSuggestion('user-1', item.content);

        expect(mockNotificationsService.notifyAdmins).toHaveBeenLastCalledWith(
          'شكوى/اقتراح جديد',
          expect.any(String),
          expect.objectContaining({
            entityId: item.id,
            suggestionId: item.id,
            route: `/dashboard/suggestions?id=${item.id}`,
          }),
        );
      }

      expect(mockNotificationsService.notifyAdmins).toHaveBeenCalledTimes(3);
    });

    it('first complaint should create a persisted admin notification with the correct suggestion ID', async () => {
      const firstComplaint = {
        id: 'first-unique-complaint-uuid-1111',
        userId: 'user-first',
        content: 'أول شكوى يتم إنشاؤها في النظام',
        whatsapp: '96770000000',
        status: 'OPEN',
        createdAt: new Date(),
        user: {
          id: 'user-first',
          fullName: 'عميل رقم 1',
          phoneNumber: '70000000',
          userType: 'individual',
          business: null,
        },
      };

      mockPrisma.suggestion.create.mockResolvedValue(firstComplaint);
      mockNotificationsService.notifyAdmins.mockResolvedValue([]);

      const created = await service.createSuggestion('user-first', firstComplaint.content, firstComplaint.whatsapp);

      expect(created.id).toBe('first-unique-complaint-uuid-1111');
      expect(mockNotificationsService.notifyAdmins).toHaveBeenCalledWith(
        'شكوى/اقتراح جديد',
        expect.stringContaining('عميل رقم 1'),
        expect.objectContaining({
          type: 'suggestion',
          entityType: 'suggestion',
          entityId: 'first-unique-complaint-uuid-1111',
          suggestionId: 'first-unique-complaint-uuid-1111',
          route: '/dashboard/suggestions?id=first-unique-complaint-uuid-1111',
        }),
      );
    });

    it('multiple consecutive complaints should each create an independent notification with its own suggestion ID', async () => {
      const batch = [
        { id: 'uuid-complaint-A', user: 'User A', text: 'Issue A' },
        { id: 'uuid-complaint-B', user: 'User B', text: 'Issue B' },
        { id: 'uuid-complaint-C', user: 'User C', text: 'Issue C' },
      ];

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        mockPrisma.suggestion.create.mockResolvedValue({
          id: item.id,
          userId: `user-${i}`,
          content: item.text,
          whatsapp: null,
          status: 'OPEN',
          createdAt: new Date(),
          user: { fullName: item.user, userType: 'individual' },
        });

        await service.createSuggestion(`user-${i}`, item.text);

        expect(mockNotificationsService.notifyAdmins).toHaveBeenLastCalledWith(
          'شكوى/اقتراح جديد',
          expect.stringContaining(item.user),
          expect.objectContaining({
            type: 'suggestion',
            entityType: 'suggestion',
            entityId: item.id,
            suggestionId: item.id,
            route: `/dashboard/suggestions?id=${item.id}`,
          }),
        );
      }
      expect(mockNotificationsService.notifyAdmins).toHaveBeenCalledTimes(3);
    });
  });
});
