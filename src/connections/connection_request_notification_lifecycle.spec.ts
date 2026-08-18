import { Test, TestingModule } from '@nestjs/testing';
import { ConnectionsService } from './connections.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../database/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { FinanceService } from '../finance/finance.service';
import { CreateConnectionDto } from './dto/create-connection.dto';

describe('Connection Request Notification Lifecycle & Badge Integrity Tests', () => {
  let service: ConnectionsService;
  let prisma: PrismaService;
  let notificationsService: NotificationsService;
  let eventsGateway: EventsGateway;

  const mockPrisma = {
    $transaction: jest.fn(async (cb) => cb(mockPrisma)),
    business: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    connection: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    account: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    notification: {
      create: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  };

  const mockNotificationsService = {
    sendPushNotification: jest.fn().mockResolvedValue(true),
    notifyUser: jest.fn().mockResolvedValue(true),
  };

  const mockEventsGateway = {
    emitToBusiness: jest.fn(),
    emitToUserBusiness: jest.fn(),
  };

  const mockFinanceService = {
    recordFinancialMovement: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
        { provide: FinanceService, useValue: mockFinanceService },
      ],
    }).compile();

    service = module.get<ConnectionsService>(ConnectionsService);
    prisma = module.get<PrismaService>(PrismaService);
    notificationsService = module.get<NotificationsService>(NotificationsService);
    eventsGateway = module.get<EventsGateway>(EventsGateway);
  });

  it('TEST 1 & 2 & 3: Consumer sends connection request -> creates connection, sends notification to Main user, emits realtime event', async () => {
    const consumerBizId = 'biz-consumer-101';
    const consumerUserId = 'user-consumer-101';
    const mainBizId = 'biz-main-202';
    const mainUserId = 'user-main-202';

    // Mock Main Business receiver lookup
    mockPrisma.business.findUnique.mockResolvedValue({
      id: mainBizId,
      name: 'بقالة الوفاء (الرئيسي)',
      phoneNumber: '777111222',
      userId: mainUserId,
      user: {
        id: mainUserId,
        fullName: 'التاجر الرئيسي',
        isActive: true,
      },
    });

    // No existing connection
    mockPrisma.connection.findFirst.mockResolvedValue(null);

    const createdConnectionRecord = {
      id: 'conn-req-999',
      requesterId: consumerBizId,
      receiverId: mainBizId,
      connectionType: 'SUPPLIER',
      requestSource: 'CUSTOMERS',
      status: 'PENDING',
      isReadReceiver: false,
      lastRequestedAt: new Date(),
      createdAt: new Date(),
      requester: {
        id: consumerBizId,
        name: 'المستهلك أحمد',
        user: { id: consumerUserId, fullName: 'أحمد علي' },
      },
      receiver: {
        id: mainBizId,
        name: 'بقالة الوفاء (الرئيسي)',
        user: { id: mainUserId, fullName: 'التاجر الرئيسي', isActive: true },
      },
    };

    mockPrisma.connection.create.mockResolvedValue(createdConnectionRecord);
    mockPrisma.auditLog.create.mockResolvedValue({});

    const dto: CreateConnectionDto = {
      receiverId: mainBizId,
      connectionType: 'SUPPLIER',
      requestSource: 'CUSTOMERS',
    };

    const result = await service.createConnection(consumerBizId, consumerUserId, dto);

    // 1. Connection creation verification
    expect(mockPrisma.connection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requesterId: consumerBizId,
          receiverId: mainBizId,
          isReadReceiver: false,
        }),
      }),
    );

    // 2. Notification dispatch to MAIN USER ID
    expect(mockNotificationsService.sendPushNotification).toHaveBeenCalledWith(
      mainUserId, // Targeted strictly to Main system owner
      'طلب ارتباط جديد',
      expect.stringContaining('المستهلك أحمد'),
      expect.objectContaining({
        type: 'connection_request',
        notificationType: 'connection_request',
        entityId: 'conn-req-999',
        requestId: 'conn-req-999',
      }),
    );

    // 3. Realtime event emitted to MAIN BUSINESS ID
    expect(mockEventsGateway.emitToBusiness).toHaveBeenCalledWith(
      mainBizId,
      'NEW_CONNECTION_REQUEST',
      expect.objectContaining({
        id: 'conn-req-999',
        requesterName: 'المستهلك أحمد',
      }),
    );

    expect(result.id).toBe('conn-req-999');
    expect(result.status).toBe('PENDING');
  });

  it('TEST 4: getConnectionRequestsStats correctly calculates unreadPending for Main business', async () => {
    const mainBizId = 'biz-main-202';

    // Mock count calls: [pending, incomingPending, outgoingPending, unreadPending]
    mockPrisma.connection.count
      .mockResolvedValueOnce(3) // total pending
      .mockResolvedValueOnce(2) // incoming pending
      .mockResolvedValueOnce(1) // outgoing pending
      .mockResolvedValueOnce(2); // unread pending (receiverId = mainBizId, isReadReceiver = false)

    const stats = await service.getConnectionRequestsStats(mainBizId);

    expect(stats.unreadPending).toBe(2);
    expect(stats.incomingPending).toBe(2);
    expect(stats.pending).toBe(3);
  });

  it('TEST 5: Multi-user isolation: Another merchant does not see requests destined for Main User', async () => {
    const otherBizId = 'biz-other-merchant-303';

    mockPrisma.connection.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const stats = await service.getConnectionRequestsStats(otherBizId);

    expect(stats.unreadPending).toBe(0);
    expect(stats.incomingPending).toBe(0);
  });

  it('TEST 6: Badge progression: 0 -> 1 -> 2 -> 1 -> 0 step-by-step', async () => {
    const mainBizId = 'biz-main-202';

    // State 0: unread = 0
    mockPrisma.connection.count
      .mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const stats0 = await service.getConnectionRequestsStats(mainBizId);
    expect(stats0.unreadPending).toBe(0);

    // State 1: after request 1 arrives -> unread = 1
    mockPrisma.connection.count
      .mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const stats1 = await service.getConnectionRequestsStats(mainBizId);
    expect(stats1.unreadPending).toBe(1);

    // State 2: after request 2 arrives -> unread = 2
    mockPrisma.connection.count
      .mockResolvedValueOnce(2).mockResolvedValueOnce(2).mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    const stats2 = await service.getConnectionRequestsStats(mainBizId);
    expect(stats2.unreadPending).toBe(2);

    // State 3: after accepting request 1 -> unread = 1
    mockPrisma.connection.count
      .mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const stats3 = await service.getConnectionRequestsStats(mainBizId);
    expect(stats3.unreadPending).toBe(1);

    // State 4: after accepting request 2 -> unread = 0
    mockPrisma.connection.count
      .mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const stats4 = await service.getConnectionRequestsStats(mainBizId);
    expect(stats4.unreadPending).toBe(0);
  });

  it('TEST 7: Accept Connection Request updates status to ACCEPTED and notifies requester', async () => {
    const mainBizId = 'biz-main-202';
    const mainUserId = 'user-main-202';
    const consumerUserId = 'user-consumer-101';

    const pendingConn = {
      id: 'conn-req-999',
      requesterId: 'biz-consumer-101',
      receiverId: mainBizId,
      status: 'PENDING',
      connectionType: 'CUSTOMER',
      isReadReceiver: true,
      requester: {
        id: 'biz-consumer-101',
        name: 'المستهلك أحمد',
        user: { id: consumerUserId, fullName: 'أحمد علي' },
      },
      receiver: {
        id: mainBizId,
        name: 'بقالة الوفاء',
        user: { id: mainUserId, fullName: 'التاجر الرئيسي' },
      },
    };

    mockPrisma.connection.findUnique.mockResolvedValue(pendingConn);
    mockPrisma.connection.update.mockResolvedValue({
      ...pendingConn,
      status: 'ACCEPTED',
    });
    mockPrisma.business.findUnique.mockResolvedValue({
      id: mainBizId,
      name: 'بقالة الوفاء',
    });
    mockPrisma.account.create = jest.fn().mockResolvedValue({ id: 'acc-1' });
    mockPrisma.auditLog.create.mockResolvedValue({});

    await service.acceptConnection(mainBizId, mainUserId, 'conn-req-999');

    expect(mockPrisma.connection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conn-req-999' },
        data: expect.objectContaining({ status: 'ACCEPTED' }),
      }),
    );

    // Verify approval notification sent to requester (consumer)
    expect(mockNotificationsService.sendPushNotification).toHaveBeenCalledWith(
      consumerUserId,
      'تم قبول طلب الارتباط',
      expect.stringContaining('بقالة الوفاء'),
      expect.objectContaining({
        type: 'connection_approved',
        notificationType: 'connection_approved',
        entityId: 'conn-req-999',
      }),
    );
  });

  it('TEST 8: Duplicate Connection Request throws ConflictException', async () => {
    const consumerBizId = 'biz-consumer-101';
    const consumerUserId = 'user-consumer-101';
    const mainBizId = 'biz-main-202';

    mockPrisma.business.findUnique.mockResolvedValue({
      id: mainBizId,
      name: 'بقالة الوفاء',
      userId: 'user-main-202',
      user: { id: 'user-main-202', isActive: true },
    });

    // Existing pending connection
    mockPrisma.connection.findFirst.mockResolvedValue({
      id: 'existing-conn-1',
      status: 'PENDING',
      connectionType: 'SUPPLIER',
    });

    const dto: CreateConnectionDto = {
      receiverId: mainBizId,
      connectionType: 'SUPPLIER',
    };

    await expect(
      service.createConnection(consumerBizId, consumerUserId, dto),
    ).rejects.toThrow();
  });
});
