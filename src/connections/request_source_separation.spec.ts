import { Test, TestingModule } from '@nestjs/testing';
import { ConnectionsService } from './connections.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { FinanceService } from '../finance/finance.service';

describe('Request Source Matrix of Truth Verification', () => {
  let service: ConnectionsService;

  const senderBizId = 'sender-biz-100';
  const receiverBizId = 'receiver-biz-200';

  let connectionsStore: any[] = [];
  let accountsStore: any[] = [];

  const mockNotificationsService = {
    sendPushNotification: jest.fn().mockResolvedValue(true),
  };

  const mockEventsGateway = {
    emitToBusiness: jest.fn(),
  };

  const mockFinanceService = {
    recordFinancialMovement: jest.fn().mockResolvedValue({}),
  };

  const mockLinkService = {
    resolveLinksForConnection: jest.fn().mockResolvedValue({}),
  };

  const mockInternalCommService = {
    checkInternalComm: jest.fn().mockResolvedValue(false),
  };

  const mockUserLookupService = {
    findUserByPhone: jest.fn().mockResolvedValue(null),
  };

  const mockPrismaService = {
    business: {
      findFirst: jest.fn().mockResolvedValue({ id: receiverBizId, name: 'مؤسسة القدس', user: { id: 'usr-200', isActive: true } }),
      findUnique: jest.fn().mockResolvedValue({ id: senderBizId, name: 'متجر السلام', user: { id: 'usr-100', isActive: true } }),
    },
    connection: {
      findFirst: jest.fn().mockImplementation(({ where }) => {
        if (where?.id) return connectionsStore.find((c) => c.id === where.id);
        return null;
      }),
      findUnique: jest.fn().mockImplementation(({ where }) => {
        return connectionsStore.find((c) => c.id === where.id);
      }),
      create: jest.fn().mockImplementation(({ data }) => {
        const conn = {
          id: `conn-${connectionsStore.length + 1}`,
          ...data,
          status: data.status || 'PENDING',
          createdAt: new Date(),
          updatedAt: new Date(),
          requester: { id: senderBizId, name: 'متجر السلام', user: { id: 'usr-100' } },
          receiver: { id: receiverBizId, name: 'مؤسسة القدس', user: { id: 'usr-200' } },
        };
        connectionsStore.push(conn);
        return conn;
      }),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const idx = connectionsStore.findIndex((c) => c.id === where.id);
        if (idx !== -1) {
          connectionsStore[idx] = {
            ...connectionsStore[idx],
            ...data,
            account: data.account?.create
              ? { id: `acc-${idx}`, ...data.account.create }
              : connectionsStore[idx].account,
          };
          return connectionsStore[idx];
        }
        return null;
      }),
    },
    account: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
    $transaction: jest.fn().mockImplementation((cb) => cb(mockPrismaService)),
  };

  beforeEach(async () => {
    connectionsStore = [];
    accountsStore = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
        { provide: FinanceService, useValue: mockFinanceService },
      ],
    }).compile();

    service = module.get<ConnectionsService>(ConnectionsService);
  });

  it('Scenario 1: Request sent from Customers screen (requestSource = CUSTOMERS)', async () => {
    // 1. Send request from Customers screen
    const request = await service.createConnection(senderBizId, 'usr-100', {
      receiverId: receiverBizId,
      connectionType: 'CUSTOMER',
      requestSource: 'CUSTOMERS',
    });

    expect(request.requestSource).toBe('CUSTOMERS');
    expect(request.connectionType).toBe('CUSTOMER'); // From sender perspective

    // Verify Receiver push notification says role is SUPPLIER (مورد)
    expect(mockNotificationsService.sendPushNotification).toHaveBeenCalledWith(
      'usr-200',
      'طلب ارتباط جديد',
      expect.stringContaining('مورد'),
      expect.objectContaining({ requestSource: 'CUSTOMERS' }),
    );

    // Verify view from Receiver perspective returns SUPPLIER role
    const receiverView = (service as any).normalizeConnection(request, receiverBizId);
    expect(receiverView.connectionType).toBe('SUPPLIER');

    // 2. Acceptance by Receiver
    const accepted = await service.acceptConnection(receiverBizId, 'usr-200', request.id, {
      creditLimit: 100000,
      openingBalance: 0,
    });

    // Verify Sender perspective = CUSTOMER, Receiver perspective = SUPPLIER
    const senderNormalized = (service as any).normalizeConnection(accepted, senderBizId);
    const receiverNormalized = (service as any).normalizeConnection(accepted, receiverBizId);

    expect(senderNormalized.connectionType).toBe('CUSTOMER');
    expect(receiverNormalized.connectionType).toBe('SUPPLIER');
  });

  it('Scenario 2: Request sent from Suppliers screen (requestSource = SUPPLIERS)', async () => {
    // 1. Send request from Suppliers screen
    const request = await service.createConnection(senderBizId, 'usr-100', {
      receiverId: receiverBizId,
      connectionType: 'SUPPLIER',
      requestSource: 'SUPPLIERS',
    });

    expect(request.requestSource).toBe('SUPPLIERS');
    expect(request.connectionType).toBe('SUPPLIER'); // From sender perspective

    // Verify Receiver push notification says role is CUSTOMER (عميل)
    expect(mockNotificationsService.sendPushNotification).toHaveBeenCalledWith(
      'usr-200',
      'طلب ارتباط جديد',
      expect.stringContaining('عميل'),
      expect.objectContaining({ requestSource: 'SUPPLIERS' }),
    );

    // Verify view from Receiver perspective returns CUSTOMER role
    const receiverView = (service as any).normalizeConnection(request, receiverBizId);
    expect(receiverView.connectionType).toBe('CUSTOMER');

    // 2. Acceptance by Receiver
    const accepted = await service.acceptConnection(receiverBizId, 'usr-200', request.id, {
      creditLimit: 50000,
      openingBalance: 0,
    });

    // Verify Sender perspective = SUPPLIER, Receiver perspective = CUSTOMER
    const senderNormalized = (service as any).normalizeConnection(accepted, senderBizId);
    const receiverNormalized = (service as any).normalizeConnection(accepted, receiverBizId);

    expect(senderNormalized.connectionType).toBe('SUPPLIER');
    expect(receiverNormalized.connectionType).toBe('CUSTOMER');
  });
});
