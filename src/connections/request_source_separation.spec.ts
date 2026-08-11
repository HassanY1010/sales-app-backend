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
    rebuildAccountBalance: jest.fn().mockResolvedValue({}),
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

  const mockPrismaService: any = {
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
          account: data.account?.create
            ? { id: `acc-${connectionsStore.length + 1}`, ...data.account.create }
            : null,
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
    transaction: {
      create: jest.fn().mockResolvedValue({ id: 'tx-1' }),
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

  it('Scenario 3: Opening Balance Truth Table Verification', async () => {
    // Case 1: Initiated from Customers screen with opening balance 2000
    const conn1 = await service.manualAddConnection(senderBizId, {
      phoneNumber: '777111222',
      name: 'شركة الناصر',
      openingBalance: 2000,
      connectionType: 'CUSTOMER',
      requestSource: 'CUSTOMERS',
    });

    const conn1Sender = (service as any).normalizeConnection(conn1, senderBizId);
    const conn1Receiver = (service as any).normalizeConnection(conn1, receiverBizId);

    // Sender sees Customer: balance 2000 -> totalDebit = 2000 (عليه), totalCredit = 0
    expect(conn1Sender.connectionType).toBe('CUSTOMER');
    expect(conn1Sender.account.totalDebit).toBe(2000);
    expect(conn1Sender.account.totalCredit).toBe(0);

    // Receiver sees Supplier: balance 2000 -> totalCredit = 2000 (له), totalDebit = 0
    expect(conn1Receiver.connectionType).toBe('SUPPLIER');
    expect(conn1Receiver.account.totalCredit).toBe(2000);
    expect(conn1Receiver.account.totalDebit).toBe(0);

    // Case 2: Initiated from Suppliers screen with opening balance 2000
    const conn2 = await service.manualAddConnection(senderBizId, {
      phoneNumber: '777333444',
      name: 'شركة الناصر 2',
      openingBalance: 2000,
      connectionType: 'SUPPLIER',
      requestSource: 'SUPPLIERS',
    });

    const conn2Sender = (service as any).normalizeConnection(conn2, senderBizId);
    const conn2Receiver = (service as any).normalizeConnection(conn2, receiverBizId);

    // Sender sees Supplier: balance 2000 -> totalCredit = 2000 (له), totalDebit = 0
    expect(conn2Sender.connectionType).toBe('SUPPLIER');
    expect(conn2Sender.account.totalCredit).toBe(2000);
    expect(conn2Sender.account.totalDebit).toBe(0);

    // Receiver sees Customer: balance 2000 -> totalDebit = 2000 (عليه), totalCredit = 0
    expect(conn2Receiver.connectionType).toBe('CUSTOMER');
    expect(conn2Receiver.account.totalDebit).toBe(2000);
    expect(conn2Receiver.account.totalCredit).toBe(0);
  });

  it('Scenario 4: Extended Edge Cases (Zero, Payments, Transitions)', async () => {
    // 1. Zero Opening Balance
    const connZero = await service.manualAddConnection(senderBizId, {
      phoneNumber: '777000111',
      name: 'عميل صفري',
      openingBalance: 0,
      connectionType: 'CUSTOMER',
      requestSource: 'CUSTOMERS',
    });
    const senderZero = (service as any).normalizeConnection(connZero, senderBizId);
    expect(senderZero.account.totalDebit).toBe(0);
    expect(senderZero.account.totalCredit).toBe(0);
    expect(senderZero.account.balance).toBe(0);

    // 2. Customer with Negative Opening Balance (-2000) (We owe Customer)
    const connNeg = await service.manualAddConnection(senderBizId, {
      phoneNumber: '777000222',
      name: 'عميل سالب',
      openingBalance: -2000,
      connectionType: 'CUSTOMER',
      requestSource: 'CUSTOMERS',
    });
    const senderNeg = (service as any).normalizeConnection(connNeg, senderBizId);
    expect(senderNeg.account.totalCredit).toBe(2000); // له
    expect(senderNeg.account.totalDebit).toBe(0);

    // 3. Balance transition from positive 2000 to 0 (Full Payment)
    const connPaid = { ...senderZero, account: { ...senderZero.account, balance: 0 } };
    const senderPaid = (service as any).normalizeConnection(connPaid, senderBizId);
    expect(senderPaid.account.totalDebit).toBe(0);
    expect(senderPaid.account.totalCredit).toBe(0);
    expect(senderPaid.account.balance).toBe(0);
  });
});
