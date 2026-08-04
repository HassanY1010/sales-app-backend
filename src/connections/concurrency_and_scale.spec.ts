import { Test, TestingModule } from '@nestjs/testing';
import { ConnectionsService } from './connections.service';
import { PrismaService } from '../database/prisma.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { ConflictException, BadRequestException } from '@nestjs/common';

describe('ConnectionsService - Concurrency & Bulk Scale Stress Verification', () => {
  let service: ConnectionsService;
  let connectionsStore: any[] = [];
  let businessesStore: any[] = [];
  let usersStore: any[] = [];
  let accountsStore: any[] = [];
  let linksStore: any[] = [];

  const mockFinanceService = {
    recordFinancialMovement: jest.fn().mockImplementation((prisma, data) => {
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

  const mockNotificationsService = {
    sendPushNotification: jest.fn().mockResolvedValue(true),
  };

  const mockEventsGateway = {
    emitToBusiness: jest.fn(),
  };

  let txQueue = Promise.resolve();

  const mockPrismaService = {
    $transaction: jest.fn().mockImplementation((cb) => {
      const result = txQueue.then(() => cb(mockPrismaService));
      txQueue = result.catch(() => {});
      return result;
    }),
    user: {
      findFirst: jest.fn().mockImplementation(({ where }) => {
        if (where?.phoneNumber) {
          return usersStore.find(
            (u) => service.normalizePhoneNumber(u.phoneNumber) === service.normalizePhoneNumber(where.phoneNumber),
          );
        }
        return null;
      }),
      findUnique: jest.fn().mockImplementation(({ where }) => {
        return usersStore.find((u) => u.id === where.id);
      }),
      create: jest.fn().mockImplementation(({ data }) => {
        const u = { id: `usr-${usersStore.length + 1}`, ...data };
        usersStore.push(u);
        return u;
      }),
    },
    business: {
      findFirst: jest.fn().mockImplementation(({ where }) => {
        if (where?.phoneNumber) {
          return businessesStore.find(
            (b) => service.normalizePhoneNumber(b.phoneNumber) === service.normalizePhoneNumber(where.phoneNumber),
          );
        }
        if (where?.OR) {
          for (const cond of where.OR) {
            if (cond.phoneNumber) {
              const found = businessesStore.find(
                (b) => service.normalizePhoneNumber(b.phoneNumber) === service.normalizePhoneNumber(cond.phoneNumber),
              );
              if (found) return found;
            }
          }
        }
        return null;
      }),
      findUnique: jest.fn().mockImplementation(({ where }) => {
        return businessesStore.find((b) => b.id === where.id);
      }),
      create: jest.fn().mockImplementation(({ data }) => {
        const b = { id: `biz-${businessesStore.length + 1}`, ...data };
        businessesStore.push(b);
        return b;
      }),
    },
    connection: {
      findFirst: jest.fn().mockImplementation(({ where }) => {
        if (where?.id) return connectionsStore.find((c) => c.id === where.id);
        if (where?.OR) {
          return connectionsStore.find((c) => {
            return where.OR.some((cond: any) => {
              if (cond.requesterId && cond.receiverId && cond.connectionType) {
                return (
                  c.requesterId === cond.requesterId &&
                  c.receiverId === cond.receiverId &&
                  c.connectionType === cond.connectionType
                );
              }
              if (cond.requesterId && cond.receiverPhone && cond.connectionType) {
                return (
                  c.requesterId === cond.requesterId &&
                  c.receiverPhone === cond.receiverPhone &&
                  c.connectionType === cond.connectionType
                );
              }
              return false;
            });
          });
        }
        if (where?.receiverPhone && where?.status === 'PENDING') {
          return connectionsStore.find(
            (c) =>
              c.receiverPhone === where.receiverPhone &&
              c.status === 'PENDING' &&
              (where.connectionType ? c.connectionType === where.connectionType : true),
          );
        }
        return null;
      }),
      findUnique: jest.fn().mockImplementation(({ where }) => {
        return connectionsStore.find((c) => c.id === where.id);
      }),
      count: jest.fn().mockImplementation(() => connectionsStore.length),
      updateMany: jest.fn().mockImplementation(({ where, data }) => {
        let count = 0;
        connectionsStore.forEach((c, idx) => {
          if (
            (where.receiverPhone ? c.receiverPhone === where.receiverPhone : true) &&
            (where.status ? c.status === where.status : true)
          ) {
            connectionsStore[idx] = { ...c, ...data };
            count++;
          }
        });
        return { count };
      }),
      findMany: jest.fn().mockImplementation(({ where }) => {
        if (where?.receiverPhone && where?.status === 'PENDING') {
          return connectionsStore.filter((c) => c.receiverPhone === where.receiverPhone && c.status === 'PENDING');
        }
        return connectionsStore;
      }),
      create: jest.fn().mockImplementation(({ data }) => {
        // Unique constraint check for race condition simulation
        const isDuplicate = connectionsStore.some(
          (c) =>
            c.requesterId === data.requesterId &&
            ((data.receiverId && c.receiverId === data.receiverId) ||
              (data.receiverPhone && c.receiverPhone === data.receiverPhone)) &&
            c.connectionType === data.connectionType &&
            (c.status === 'PENDING' || c.status === 'ACCEPTED'),
        );

        if (isDuplicate) {
          const error: any = new Error('Unique constraint failed on the fields: (`requesterId`,`receiverId`,`connectionType`)');
          error.code = 'P2002';
          throw error;
        }

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
        return accountsStore.find((a) => a.connectionId === where.connectionId || a.id === where.id);
      }),
      create: jest.fn().mockImplementation(({ data }) => {
        const acc = { id: `acc-${accountsStore.length + 1}`, ...data };
        accountsStore.push(acc);
        return acc;
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
    customerSupplierLink: {
      findFirst: jest.fn().mockImplementation(() => null),
      create: jest.fn().mockImplementation(({ data }) => {
        const link = { id: `link-${linksStore.length + 1}`, ...data };
        linksStore.push(link);
        return link;
      }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  };

  beforeEach(async () => {
    connectionsStore = [];
    businessesStore = [];
    usersStore = [];
    accountsStore = [];
    linksStore = [];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: FinanceService, useValue: mockFinanceService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    service = module.get<ConnectionsService>(ConnectionsService);
  });

  // ── 1. CONCURRENCY TESTS ───────────────────────────────────────────────────
  describe('1. Concurrency & Race Condition Verification', () => {
    it('handles simultaneous connection requests from two devices gracefully without creating duplicates or uncaught Prisma errors', async () => {
      // Setup Device 1 business (A) and Registered target business (B)
      const bizA = { id: 'biz-a', name: 'Business A', phoneNumber: '777111111', user: { id: 'usr-a' } };
      const bizB = { id: 'biz-b', name: 'Business B', phoneNumber: '777222222', user: { id: 'usr-b' } };
      businessesStore.push(bizA, bizB);

      // Attempt 2 simultaneous requests in the exact same millisecond
      const req1Promise = service.sendRelationshipRequestByPhone('biz-a', 'usr-a', {
        phoneNumber: '777222222',
        connectionType: 'CUSTOMER',
        requestSource: 'CUSTOMERS',
      });

      const req2Promise = service.sendRelationshipRequestByPhone('biz-a', 'usr-a', {
        phoneNumber: '777222222',
        connectionType: 'CUSTOMER',
        requestSource: 'CUSTOMERS',
      });

      const results = await Promise.allSettled([req1Promise, req2Promise]);

      // Exactly ONE request must succeed, and the other must return ConflictException
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

      // Ensure DB store contains EXACTLY ONE connection record
      expect(connectionsStore.length).toBe(1);
      expect(connectionsStore[0].requesterId).toBe('biz-a');
      expect(connectionsStore[0].receiverId).toBe('biz-b');
    });

    it('handles simultaneous acceptance of the same connection request without race condition corruption', async () => {
      const bizA = { id: 'biz-a', name: 'Business A', phoneNumber: '777111111', user: { id: 'usr-a' } };
      const bizB = { id: 'biz-b', name: 'Business B', phoneNumber: '777222222', user: { id: 'usr-b' } };
      businessesStore.push(bizA, bizB);

      // Create initial pending request
      const conn = await service.sendRelationshipRequestByPhone('biz-a', 'usr-a', {
        phoneNumber: '777222222',
        connectionType: 'CUSTOMER',
        requestSource: 'CUSTOMERS',
        openingBalance: 2000,
        creditLimit: 10000,
      });

      // Receiver B attempts to accept from 2 active mobile sessions simultaneously
      const accept1Promise = service.acceptConnection('biz-b', 'usr-b', conn.id);
      const accept2Promise = service.acceptConnection('biz-b', 'usr-b', conn.id);

      const results = await Promise.allSettled([accept1Promise, accept2Promise]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);

      // Connection state must be ACCEPTED, exactly ONE account created
      expect(connectionsStore[0].status).toBe('ACCEPTED');
      expect(accountsStore.length).toBe(1);
    });

    it('migrates multiple pending requests safely when unregistered user signs up', async () => {
      const bizA = { id: 'biz-a', name: 'Business A', phoneNumber: '777111111', user: { id: 'usr-a' } };
      const bizB = { id: 'biz-b', name: 'Business B', phoneNumber: '777222222', user: { id: 'usr-b' } };
      businessesStore.push(bizA, bizB);

      // Create 2 pending requests to same unregistered phone (one as Customer, one as Supplier)
      await service.sendRelationshipRequestByPhone('biz-a', 'usr-a', {
        phoneNumber: '777333333',
        personalName: 'Future User C',
        connectionType: 'CUSTOMER',
        requestSource: 'CUSTOMERS',
        openingBalance: 1000,
      });

      await service.sendRelationshipRequestByPhone('biz-b', 'usr-b', {
        phoneNumber: '777333333',
        personalName: 'Future User C',
        connectionType: 'SUPPLIER',
        requestSource: 'SUPPLIERS',
      });

      expect(connectionsStore.length).toBe(2);

      // User C signs up with phone 777333333
      const bizC = { id: 'biz-c', name: 'Business C', phoneNumber: '777333333', user: { id: 'usr-c' } };
      businessesStore.push(bizC);

      await service.linkPendingRequestsAfterRegistration('777333333', 'biz-c', 'usr-c');

      // Both connections must be linked to receiverId: 'biz-c'
      const linkedReqs = connectionsStore.filter((c) => c.receiverId === 'biz-c');
      expect(linkedReqs.length).toBe(2);
      expect(linkedReqs.every((c) => c.status === 'PENDING')).toBe(true);
    });
  });

  // ── 2. BULK SCALE & PERFORMANCE STRESS TEST ──────────────────────────────
  describe('2. Bulk Scale Stress Test (100 Accounts Data Payload)', () => {
    it('creates 50 Customers, 50 Suppliers, and 10 Dual-Role relationships with isolated accounts & balances', async () => {
      const mainBiz = { id: 'biz-main', name: 'Main Hub Enterprise', phoneNumber: '770000000', user: { id: 'usr-main' } };
      businessesStore.push(mainBiz);

      // 1. Create 50 Customer relationships
      for (let i = 1; i <= 50; i++) {
        const phone = `7710000${i.toString().padStart(2, '0')}`;
        const targetBiz = { id: `biz-cust-${i}`, name: `Customer ${i}`, phoneNumber: phone, user: { id: `usr-cust-${i}` } };
        businessesStore.push(targetBiz);

        const req = await service.sendRelationshipRequestByPhone('biz-main', 'usr-main', {
          phoneNumber: phone,
          connectionType: 'CUSTOMER',
          requestSource: 'CUSTOMERS',
          openingBalance: i * 100,
          creditLimit: 5000,
        });

        // Accept connection directly
        await service.acceptConnection(targetBiz.id, targetBiz.user.id, req.id);
      }

      // 2. Create 50 Supplier relationships
      for (let i = 1; i <= 50; i++) {
        const phone = `7720000${i.toString().padStart(2, '0')}`;
        const targetBiz = { id: `biz-supp-${i}`, name: `Supplier ${i}`, phoneNumber: phone, user: { id: `usr-supp-${i}` } };
        businessesStore.push(targetBiz);
        businessesStore.push(targetBiz);

        const req = await service.sendRelationshipRequestByPhone('biz-main', 'usr-main', {
          phoneNumber: phone,
          connectionType: 'SUPPLIER',
          requestSource: 'SUPPLIERS',
        });

        // Accept connection with financial input
        await service.acceptConnection(targetBiz.id, targetBiz.user.id, req.id, {
          openingBalance: i * 500,
          creditLimit: 20000,
        });
      }

      // 3. Create 10 Dual-Role relationships (same business as both Customer & Supplier)
      for (let i = 1; i <= 10; i++) {
        const phone = `7730000${i.toString().padStart(2, '0')}`;
        const dualBiz = { id: `biz-dual-${i}`, name: `Dual Entity ${i}`, phoneNumber: phone, user: { id: `usr-dual-${i}` } };
        businessesStore.push(dualBiz);

        // Add as Customer
        const custReq = await service.sendRelationshipRequestByPhone('biz-main', 'usr-main', {
          phoneNumber: phone,
          connectionType: 'CUSTOMER',
          requestSource: 'CUSTOMERS',
          openingBalance: 1000,
        });
        await service.acceptConnection(dualBiz.id, dualBiz.user.id, custReq.id);

        // Add as Supplier
        const suppReq = await service.sendRelationshipRequestByPhone('biz-main', 'usr-main', {
          phoneNumber: phone,
          connectionType: 'SUPPLIER',
          requestSource: 'SUPPLIERS',
        });
        await service.acceptConnection(dualBiz.id, dualBiz.user.id, suppReq.id, {
          openingBalance: 5000,
          creditLimit: 20000,
        });
      }

      // Total Connections Created = 50 + 50 + 20 = 120 Connection records
      expect(connectionsStore.length).toBe(120);

      // Verify that every single Dual-Role entity has 2 separate connection IDs and 2 separate Accounts
      for (let i = 1; i <= 10; i++) {
        const dualId = `biz-dual-${i}`;
        const dualConns = connectionsStore.filter(
          (c) => (c.requesterId === dualId || c.receiverId === dualId) && c.status === 'ACCEPTED',
        );

        expect(dualConns.length).toBe(2);
        const custConn = dualConns.find((c) => c.connectionType === 'CUSTOMER');
        const suppConn = dualConns.find((c) => c.connectionType === 'SUPPLIER');

        expect(custConn.id).not.toBe(suppConn.id);
        expect(custConn.account.id).not.toBe(suppConn.account.id);
      }
    });
  });
});
