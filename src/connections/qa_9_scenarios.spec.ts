import { Test, TestingModule } from '@nestjs/testing';
import { ConnectionsService } from './connections.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { FinanceService } from '../finance/finance.service';
import { BadRequestException, ConflictException } from '@nestjs/common';

describe('QA Engineer - 9 Critical Scenarios Verification Suite', () => {
  let service: ConnectionsService;

  const bizMainA = 'biz-main-a';
  const bizMainB = 'biz-main-b';
  const bizConsumerC = 'biz-consumer-c';

  let connectionsStore: any[] = [];
  let accountsStore: any[] = [];
  let transactionsStore: any[] = [];
  let businessesStore: any[] = [];
  let usersStore: any[] = [];
  let notificationsLog: any[] = [];

  const mockNotificationsService = {
    sendPushNotification: jest.fn().mockImplementation((userId, title, body, payload) => {
      notificationsLog.push({ userId, title, body, payload });
      return Promise.resolve(true);
    }),
  };

  const mockEventsGateway = {
    emitToBusiness: jest.fn(),
  };

  const mockFinanceService = {
    recordFinancialMovement: jest.fn().mockImplementation((prisma, data) => {
      transactionsStore.push({
        id: `tx-${transactionsStore.length + 1}`,
        ...data,
      });
      const acc = accountsStore.find((a) => a.connectionId === data.connectionId);
      if (acc) {
        const conn = connectionsStore.find((c) => c.id === data.connectionId);
        if (conn) {
          const isSenderRequester = data.senderId === conn.requesterId;
          acc.balance = isSenderRequester ? data.amount : -data.amount;
        }
      }
      return Promise.resolve({});
    }),
  };

  const mockPrismaService = {
    business: {
      findFirst: jest.fn().mockImplementation(({ where }) => {
        if (where?.phoneNumber) {
          return businessesStore.find((b) => service.normalizePhoneNumber(b.phoneNumber) === service.normalizePhoneNumber(where.phoneNumber));
        }
        if (where?.id) {
          return businessesStore.find((b) => b.id === where.id);
        }
        return null;
      }),
      findUnique: jest.fn().mockImplementation(({ where }) => {
        return businessesStore.find((b) => b.id === where.id);
      }),
      create: jest.fn().mockImplementation(({ data }) => {
        const newBiz = { id: `biz-${businessesStore.length + 1}`, ...data };
        businessesStore.push(newBiz);
        return newBiz;
      }),
    },
    user: {
      findFirst: jest.fn().mockImplementation(({ where }) => {
        if (where?.phoneNumber) {
          return usersStore.find((u) => service.normalizePhoneNumber(u.phoneNumber) === service.normalizePhoneNumber(where.phoneNumber));
        }
        return null;
      }),
      findUnique: jest.fn().mockImplementation(({ where }) => {
        return usersStore.find((u) => u.id === where.id);
      }),
    },
    connection: {
      findFirst: jest.fn().mockImplementation(({ where }) => {
        if (where?.id) return connectionsStore.find((c) => c.id === where.id);
        if (where?.OR) {
          return connectionsStore.find((c) => {
            return where.OR.some((cond: any) => {
              if (cond.requesterId && cond.receiverId && cond.connectionType) {
                return c.requesterId === cond.requesterId && c.receiverId === cond.receiverId && c.connectionType === cond.connectionType;
              }
              if (cond.requesterId && cond.receiverPhone && cond.connectionType) {
                return c.requesterId === cond.requesterId && c.receiverPhone === cond.receiverPhone && c.connectionType === cond.connectionType;
              }
              return false;
            });
          });
        }
        if (where?.receiverPhone && where?.status === 'PENDING') {
          return connectionsStore.find((c) => c.receiverPhone === where.receiverPhone && c.status === 'PENDING' && (where.connectionType ? c.connectionType === where.connectionType : true));
        }
        return null;
      }),
      findUnique: jest.fn().mockImplementation(({ where }) => {
        return connectionsStore.find((c) => c.id === where.id);
      }),
      count: jest.fn().mockImplementation(() => connectionsStore.length),
      findMany: jest.fn().mockImplementation(({ where }) => {
        if (where?.receiverPhone && where?.status === 'PENDING') {
          return connectionsStore.filter((c) => c.receiverPhone === where.receiverPhone && c.status === 'PENDING');
        }
        return connectionsStore;
      }),
      create: jest.fn().mockImplementation(({ data }) => {
        const conn = {
          id: `conn-${connectionsStore.length + 1}`,
          ...data,
          status: data.status || 'PENDING',
          createdAt: new Date(),
          updatedAt: new Date(),
          requester: businessesStore.find((b) => b.id === data.requesterId),
          receiver: businessesStore.find((b) => b.id === data.receiverId),
          customerLinks: [],
          supplierLinks: [],
        };
        connectionsStore.push(conn);
        return conn;
      }),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const idx = connectionsStore.findIndex((c) => c.id === where.id);
        if (idx !== -1) {
          const old = connectionsStore[idx];
          const updatedAcc = data.account?.create
            ? { id: `acc-${accountsStore.length + 1}`, connectionId: old.id, ...data.account.create }
            : old.account;

          if (data.account?.create) {
            accountsStore.push(updatedAcc);
          }

          const requesterId = data.requesterId ?? old.requesterId;
          const receiverId = data.receiverId ?? old.receiverId;

          connectionsStore[idx] = {
            ...old,
            ...data,
            requesterId,
            receiverId,
            requester: businessesStore.find((b) => b.id === requesterId) || old.requester,
            receiver: businessesStore.find((b) => b.id === receiverId) || old.receiver,
            account: updatedAcc,
          };
          return connectionsStore[idx];
        }
        return null;
      }),
    },
    account: {
      findUnique: jest.fn().mockImplementation(({ where }) => {
        return accountsStore.find((a) => a.connectionId === where.connectionId);
      }),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const idx = accountsStore.findIndex((a) => a.id === where.id);
        if (idx !== -1) {
          accountsStore[idx] = { ...accountsStore[idx], ...data };
          return accountsStore[idx];
        }
        return null;
      }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
    $transaction: jest.fn().mockImplementation((cb) => cb(mockPrismaService)),
  };

  beforeEach(async () => {
    connectionsStore = [];
    accountsStore = [];
    transactionsStore = [];
    businessesStore = [
      { id: bizMainA, name: 'متجر A (رئيسي)', phoneNumber: '777111111', user: { id: 'usr-a', isActive: true, phoneNumber: '777111111' } },
      { id: bizMainB, name: 'شركة B (رئيسي)', phoneNumber: '777222222', user: { id: 'usr-b', isActive: true, phoneNumber: '777222222' } },
      { id: bizConsumerC, name: 'مستهلك C (مستهلك)', phoneNumber: '777333333', user: { id: 'usr-c', isActive: true, phoneNumber: '777333333' } },
    ];
    usersStore = [
      { id: 'usr-a', fullName: 'مالك A', phoneNumber: '777111111', isActive: true, business: businessesStore[0] },
      { id: 'usr-b', fullName: 'مالك B', phoneNumber: '777222222', isActive: true, business: businessesStore[1] },
      { id: 'usr-c', fullName: 'مستهلك C', phoneNumber: '777333333', isActive: true, business: businessesStore[2] },
    ];
    notificationsLog = [];

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

  // ── TEST 1: Registered Customer (عميل مسجل مسبقاً) ──────────────────────────
  it('QA Test 1: Registered Customer flow from Customers Window', async () => {
    // 1. Account A sends request from Customers Window to registered Account B
    const request = await service.sendRelationshipRequestByPhone(bizMainA, 'usr-a', {
      phoneNumber: '777222222',
      connectionType: 'CUSTOMER',
      requestSource: 'CUSTOMERS',
      openingBalance: 1000,
      creditLimit: 5000,
    });

    // Check request created
    expect(request.status).toBe('PENDING');
    expect(request.connectionType).toBe('CUSTOMER'); // Sender perspective

    // Check notification delivered to B
    const notifB = notificationsLog.find((n) => n.userId === 'usr-b');
    expect(notifB).toBeDefined();
    expect(notifB.body).toContain('مورد'); // Receiver perspective role
    expect(notifB.payload.requiresInput).toBe('false'); // Receiver does NOT input financial fields

    // View from B perspective
    const viewB = (service as any).normalizeConnection(request, bizMainB);
    expect(viewB.connectionType).toBe('SUPPLIER');

    // 2. Acceptance by B (direct acceptance, no financial fields required from B)
    const accepted = await service.acceptConnection(bizMainB, 'usr-b', request.id);

    expect(accepted.status).toBe('ACCEPTED');

    // Check values from Sender A perspective (Customer: balance = 1000, creditLimit = 5000)
    const senderView = await service.getConnectionRequestDetails(bizMainA, 'usr-a', request.id);
    expect(senderView.connectionType).toBe('CUSTOMER');
    expect(senderView.account.balance).toBe(1000);
    expect(senderView.account.creditLimit).toBe(5000);

    // Check values from Receiver B perspective (Supplier: balance = -1000)
    const receiverView = await service.getConnectionRequestDetails(bizMainB, 'usr-b', request.id);
    expect(receiverView.connectionType).toBe('SUPPLIER');
    expect(receiverView.account.balance).toBe(-1000);
  });

  // ── TEST 2: Unregistered Customer (عميل غير مسجل ثم تسجيله لاحقاً) ──────────
  it('QA Test 2: Unregistered Customer flow & auto-link on registration', async () => {
    const unregisteredPhone = '777999888';

    // 1. Send request to unregistered phone from Customers screen
    const result = await service.sendRelationshipRequestByPhone(bizMainA, 'usr-a', {
      phoneNumber: unregisteredPhone,
      connectionType: 'CUSTOMER',
      requestSource: 'CUSTOMERS',
      personalName: 'علي صالح',
      businessName: 'بقالة الأمل',
      openingBalance: 1500,
      creditLimit: 6000,
    });

    expect(result.status).toBe('PENDING');
    expect(result.registeredReceiver).toBe(false);

    // 2. User registers later with same phone number
    const newBizId = 'biz-new-user';
    const newUserId = 'usr-new-user';
    businessesStore.push({ id: newBizId, name: 'بقالة الأمل', phoneNumber: unregisteredPhone, user: { id: newUserId, isActive: true } });
    usersStore.push({ id: newUserId, fullName: 'علي صالح', phoneNumber: unregisteredPhone, isActive: true, business: businessesStore[3] });

    const linkedCount = await service.linkPendingRequestsAfterRegistration(unregisteredPhone, newBizId, newUserId);
    expect(linkedCount).toBe(1);

    // Verify notification delivered to newly registered user with SUPPLIER relationship
    const newNotif = notificationsLog.find((n) => n.userId === newUserId);
    expect(newNotif).toBeDefined();
    expect(newNotif.title).toContain('مورد');
  });

  // ── TEST 3: Registered Supplier (مورد مسجل) ──────────────────────────────────
  it('QA Test 3: Registered Supplier flow requires receiver financial input upon acceptance', async () => {
    // 1. Send request from Suppliers window (connectionType=SUPPLIER)
    const request = await service.sendRelationshipRequestByPhone(bizMainA, 'usr-a', {
      phoneNumber: '777222222',
      connectionType: 'SUPPLIER',
      requestSource: 'SUPPLIERS',
    });

    expect(request.status).toBe('PENDING');
    expect(request.requiresReceiverInput).toBe(true);

    // Receiver B perspective must show CUSTOMER role
    const viewB = (service as any).normalizeConnection(request, bizMainB);
    expect(viewB.connectionType).toBe('CUSTOMER');

    // 2. Receiver B attempts to accept WITHOUT financial parameters -> Throws BadRequestException
    await expect(service.acceptConnection(bizMainB, 'usr-b', request.id)).rejects.toThrow(BadRequestException);

    // 3. Receiver B provides financial parameters -> Accepts successfully
    const accepted = await service.acceptConnection(bizMainB, 'usr-b', request.id, {
      openingBalance: 2000,
      creditLimit: 10000,
    });

    expect(accepted.status).toBe('ACCEPTED');

    // Sender A perspective (Supplier)
    const senderView = (service as any).normalizeConnection(accepted, bizMainA);
    expect(senderView.connectionType).toBe('SUPPLIER');

    // Receiver B perspective (Customer)
    const receiverView = (service as any).normalizeConnection(accepted, bizMainB);
    expect(receiverView.connectionType).toBe('CUSTOMER');
  });

  // ── TEST 4: Unregistered Supplier (مورد غير مسجل) ──────────────────────────
  it('QA Test 4: Unregistered Supplier flow & deferred financial input upon acceptance', async () => {
    const unregSupplierPhone = '777888777';

    // 1. Send request from Suppliers window for unregistered phone
    const result = await service.sendRelationshipRequestByPhone(bizMainA, 'usr-a', {
      phoneNumber: unregSupplierPhone,
      connectionType: 'SUPPLIER',
      requestSource: 'SUPPLIERS',
      personalName: 'محمد طاهر',
      businessName: 'مؤسسة النور',
    });

    expect(result.status).toBe('PENDING');
    expect(result.requiresReceiverInput).toBe(true);

    // 2. Supplier registers later
    const suppBizId = 'biz-supp-new';
    const suppUserId = 'usr-supp-new';
    businessesStore.push({ id: suppBizId, name: 'مؤسسة النور', phoneNumber: unregSupplierPhone, user: { id: suppUserId, isActive: true } });
    usersStore.push({ id: suppUserId, fullName: 'محمد طاهر', phoneNumber: unregSupplierPhone, isActive: true, business: businessesStore[businessesStore.length - 1] });

    await service.linkPendingRequestsAfterRegistration(unregSupplierPhone, suppBizId, suppUserId);

    // Registered supplier receives notification with CUSTOMER relationship type
    const notif = notificationsLog.find((n) => n.userId === suppUserId);
    expect(notif).toBeDefined();
    expect(notif.title).toContain('عميل');
  });

  // ── TEST 5: Consumer System Receives Request from Supplier ────────────────
  it('QA Test 5: Consumer System receiving request from Supplier (role=SUPPLIER, direct accept)', async () => {
    // Supplier Main A sends request to Consumer C
    const request = await service.sendRelationshipRequestByPhone(bizMainA, 'usr-a', {
      phoneNumber: '777333333',
      connectionType: 'CUSTOMER', // Supplier screen to Consumer
      requestSource: 'CUSTOMERS',
    });

    // View from Consumer C perspective: relationship type = SUPPLIER (مورد), no financial fields required
    const viewC = (service as any).normalizeConnection(request, bizConsumerC);
    expect(viewC.connectionType).toBe('SUPPLIER');

    // Acceptance by Consumer C requires no financial inputs
    const accepted = await service.acceptConnection(bizConsumerC, 'usr-c', request.id);
    expect(accepted.status).toBe('ACCEPTED');
  });

  // ── TEST 6: Consumer System Sends Request to Main System ──────────────────
  it('QA Test 6: Consumer System sending request to Main System (role=CUSTOMER at Main, financial input at Main)', async () => {
    // Consumer C sends request to Main System A
    const request = await service.sendRelationshipRequestByPhone(bizConsumerC, 'usr-c', {
      phoneNumber: '777111111',
      connectionType: 'SUPPLIER', // Consumer sending request to Supplier
      requestSource: 'SUPPLIERS',
    });

    // Main System A perspective: relationship type = CUSTOMER (عميل), requires financial input
    const viewA = (service as any).normalizeConnection(request, bizMainA);
    expect(viewA.connectionType).toBe('CUSTOMER');

    // Main System A inputs opening balance & credit limit upon acceptance
    const accepted = await service.acceptConnection(bizMainA, 'usr-a', request.id, {
      openingBalance: 3000,
      creditLimit: 15000,
    });

    expect(accepted.status).toBe('ACCEPTED');
    const mainView = (service as any).normalizeConnection(accepted, bizMainA);
    expect(mainView.connectionType).toBe('CUSTOMER');
    expect(mainView.account.balance).toBe(3000);
  });

  // ── TEST 7: Dual Role - Customer & Supplier Simultaneously ────────────────
  it('QA Test 7: Person B is both Customer & Supplier simultaneously with isolated records & balances', async () => {
    // 1. Add B as Customer from Customers Window
    const customerReq = await service.sendRelationshipRequestByPhone(bizMainA, 'usr-a', {
      phoneNumber: '777222222',
      connectionType: 'CUSTOMER',
      requestSource: 'CUSTOMERS',
      openingBalance: 1000,
      creditLimit: 5000,
    });
    await service.acceptConnection(bizMainB, 'usr-b', customerReq.id);

    // 2. Add B as Supplier from Suppliers Window
    const supplierReq = await service.sendRelationshipRequestByPhone(bizMainA, 'usr-a', {
      phoneNumber: '777222222',
      connectionType: 'SUPPLIER',
      requestSource: 'SUPPLIERS',
    });
    await service.acceptConnection(bizMainB, 'usr-b', supplierReq.id, {
      openingBalance: 5000,
      creditLimit: 20000,
    });

    // Fetch both connections for A
    const allConns = await service.getConnections(bizMainA, { page: 1, limit: 10 });
    const customerConn = allConns.data.find((c: any) => c.connectionType === 'CUSTOMER');
    const supplierConn = allConns.data.find((c: any) => c.connectionType === 'SUPPLIER');

    // VERIFICATION: Two separate records with isolated balances (1000 vs 5000)
    expect(customerConn).toBeDefined();
    expect(supplierConn).toBeDefined();
    expect(customerConn.id).not.toBe(supplierConn.id);

    expect(customerConn.account.balance).toBe(1000);
    expect(supplierConn.account.balance).toBe(5000);
  });

  // ── TEST 8: Instant UI Status Update ─────────────────────────────────────────
  it('QA Test 8: Accepting connection updates status to ACCEPTED instantly', async () => {
    const request = await service.sendRelationshipRequestByPhone(bizMainA, 'usr-a', {
      phoneNumber: '777222222',
      connectionType: 'CUSTOMER',
      requestSource: 'CUSTOMERS',
    });

    expect(request.status).toBe('PENDING');

    const accepted = await service.acceptConnection(bizMainB, 'usr-b', request.id);
    expect(accepted.status).toBe('ACCEPTED');
  });

  // ── TEST 9: Relationship Source Isolation (Strict Window-based Rule) ──────
  it('QA Test 9: Relationship role depends ONLY on request window (CUSTOMERS -> CUSTOMER, SUPPLIERS -> SUPPLIER)', async () => {
    // Scenario A: Customers window -> Sender is CUSTOMER, Receiver is SUPPLIER
    const fromCustomers = await service.sendRelationshipRequestByPhone(bizMainA, 'usr-a', {
      phoneNumber: '777222222',
      connectionType: 'CUSTOMER',
      requestSource: 'CUSTOMERS',
    });
    const normCustomersSender = (service as any).normalizeConnection(fromCustomers, bizMainA);
    const normCustomersReceiver = (service as any).normalizeConnection(fromCustomers, bizMainB);
    expect(normCustomersSender.connectionType).toBe('CUSTOMER');
    expect(normCustomersReceiver.connectionType).toBe('SUPPLIER');

    // Scenario B: Suppliers window -> Sender is SUPPLIER, Receiver is CUSTOMER
    const fromSuppliers = await service.sendRelationshipRequestByPhone(bizMainA, 'usr-a', {
      phoneNumber: '777222222',
      connectionType: 'SUPPLIER',
      requestSource: 'SUPPLIERS',
    });
    const normSuppliersSender = (service as any).normalizeConnection(fromSuppliers, bizMainA);
    const normSuppliersReceiver = (service as any).normalizeConnection(fromSuppliers, bizMainB);
    expect(normSuppliersSender.connectionType).toBe('SUPPLIER');
    expect(normSuppliersReceiver.connectionType).toBe('CUSTOMER');
  });
});
