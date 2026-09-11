import { Test, TestingModule } from '@nestjs/testing';
import { ConnectionsService } from './connections.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { FinanceService } from '../finance/finance.service';

describe('Case 6: Opening Balance & Credit Limit Notification Routing Live Simulation', () => {
  let service: ConnectionsService;

  const bizMerchant = 'biz-merchant-1';
  const userMerchant = 'user-merchant-1';
  const bizCustomer = 'biz-customer-2';
  const userCustomer = 'user-customer-2';

  let connectionsStore: any[] = [];
  let accountsStore: any[] = [];
  let notificationsLog: any[] = [];
  let dbNotifications: any[] = [];

  const mockNotificationsService = {
    sendPushNotification: jest.fn().mockImplementation((userId, title, body, payload) => {
      notificationsLog.push({ userId, title, body, payload });
      return Promise.resolve(true);
    }),
    createNotification: jest.fn().mockImplementation((data) => {
      dbNotifications.push(data);
      return Promise.resolve({ id: 'db-notif-1', ...data });
    }),
  };

  const mockEventsGateway = {
    emitToBusiness: jest.fn(),
  };

  const mockFinanceService = {
    recordFinancialMovement: jest.fn().mockResolvedValue({ id: 'tx-1' }),
  };

  const mockPrismaService = {
    business: {
      findUnique: jest.fn().mockImplementation(({ where }) => {
        if (where.id === bizMerchant) {
          return { id: bizMerchant, name: 'محلات الناصر', user: { id: userMerchant, isActive: true } };
        }
        if (where.id === bizCustomer) {
          return { id: bizCustomer, name: 'بقالة صنعاء', user: { id: userCustomer, isActive: true } };
        }
        return null;
      }),
    },
    user: {
      findUnique: jest.fn().mockImplementation(({ where }) => {
        if (where.id === userMerchant) return { id: userMerchant, name: 'الناصر', business: { id: bizMerchant } };
        if (where.id === userCustomer) return { id: userCustomer, name: 'صنعاء', business: { id: bizCustomer } };
        return null;
      }),
    },
    connection: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => {
        const newConn = {
          id: `conn-${connectionsStore.length + 1}`,
          status: 'PENDING',
          ...data,
          requester: { id: data.requesterId, name: data.requesterId === bizMerchant ? 'محلات الناصر' : 'بقالة صنعاء', user: { id: data.requesterId === bizMerchant ? userMerchant : userCustomer } },
          receiver: { id: data.receiverId, name: data.receiverId === bizCustomer ? 'بقالة صنعاء' : 'محلات الناصر', user: { id: data.receiverId === bizCustomer ? userCustomer : userMerchant } },
        };
        connectionsStore.push(newConn);
        return newConn;
      }),
      findUnique: jest.fn().mockImplementation(({ where }) => {
        return connectionsStore.find((c) => c.id === where.id) || null;
      }),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const idx = connectionsStore.findIndex((c) => c.id === where.id);
        if (idx !== -1) {
          connectionsStore[idx] = {
            ...connectionsStore[idx],
            ...data,
            account: { id: 'acc-1', balance: data.account?.create?.balance || 0, creditLimit: data.account?.create?.creditLimit || 0 },
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
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation(async (callback) => {
      return callback(mockPrismaService);
    }),
  };

  beforeEach(async () => {
    connectionsStore = [];
    accountsStore = [];
    notificationsLog = [];
    dbNotifications = [];
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

  it('🔴 SCENARIO 1 (Customers Window): Merchant sends request with opening balance & credit limit -> Customer accepts -> Customer gets the financial notification with Merchant name', async () => {
    // 1. Merchant sends connection request from CUSTOMERS window
    const conn = await service.createConnection(bizMerchant, userMerchant, {
      receiverId: bizCustomer,
      requestSource: 'CUSTOMERS',
      openingBalance: 50000,
      creditLimit: 100000,
    });

    expect(conn.pendingOpenBalance).toBe(50000);
    expect(conn.pendingCreditLimit).toBe(100000);

    notificationsLog = []; // clear request creation push

    // 2. Customer accepts connection
    await service.acceptConnection(bizCustomer, userCustomer, conn.id, {});

    // 3. Verify notification recipient and content
    // The OPENING_BALANCE / terms notification MUST go to userCustomer (NOT userMerchant!)
    const termsNotification = notificationsLog.find((n) => n.userId === userCustomer && n.title === 'تفعيل الرصيد وسقف المديونية');
    expect(termsNotification).toBeDefined();
    expect(termsNotification.userId).toBe(userCustomer); // Sent to Customer!
    expect(termsNotification.payload.senderRole).toBe('المورد');
    expect(termsNotification.payload.senderName).toBe('محلات الناصر');
    expect(termsNotification.payload.openingBalance).toBe('50000');
    expect(termsNotification.payload.creditLimit).toBe('100000');
    expect(termsNotification.body).toContain('محلات الناصر');
    expect(termsNotification.body).toContain('50,000');
    expect(termsNotification.body).toContain('100,000');

    // Merchant gets regular approval notification
    const approvalNotification = notificationsLog.find((n) => n.userId === userMerchant && n.title === 'تم قبول طلب الارتباط');
    expect(approvalNotification).toBeDefined();
    expect(approvalNotification.userId).toBe(userMerchant);
    expect(approvalNotification.body).toContain('بقالة صنعاء');
  });

  it('🔴 SCENARIO 2 (Suppliers Window): Customer sends request -> Supplier enters opening balance & credit limit on accept -> Customer gets financial notification with Supplier name', async () => {
    // 1. Customer sends connection request from SUPPLIERS window
    const conn = await service.createConnection(bizCustomer, userCustomer, {
      receiverId: bizMerchant,
      requestSource: 'SUPPLIERS',
    });

    expect(conn.requiresReceiverInput).toBe(true);

    notificationsLog = [];

    // 2. Supplier accepts and enters opening balance and credit limit
    await service.acceptConnection(bizMerchant, userMerchant, conn.id, {
      openingBalance: 75000,
      creditLimit: 150000,
    });

    // 3. Verify notification recipient and content
    // The notification MUST go to userCustomer (the requester)
    const termsNotification = notificationsLog.find((n) => n.userId === userCustomer && n.title === 'تفعيل الرصيد وسقف المديونية');
    expect(termsNotification).toBeDefined();
    expect(termsNotification.userId).toBe(userCustomer); // Sent to Customer!
    expect(termsNotification.payload.senderRole).toBe('المورد');
    expect(termsNotification.payload.senderName).toBe('محلات الناصر');
    expect(termsNotification.payload.openingBalance).toBe('75000');
    expect(termsNotification.payload.creditLimit).toBe('150000');
    expect(termsNotification.body).toContain('محلات الناصر');
    expect(termsNotification.body).toContain('75,000');
    expect(termsNotification.body).toContain('150,000');
  });
});
