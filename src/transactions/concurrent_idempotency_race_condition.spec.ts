import { Decimal } from 'decimal.js';
import { TransactionsService } from './transactions.service';
import { FinanceService } from '../finance/finance.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { Test, TestingModule } from '@nestjs/testing';

describe('Same clientId Concurrent Race-Condition & Idempotency Audit', () => {
  let transactionsService: TransactionsService;
  let financeService: FinanceService;

  let store: {
    accounts: Map<string, any>;
    transactions: any[];
    orders: Map<string, any>;
    connections: Map<string, any>;
  };

  let mockPrisma: any;

  beforeEach(async () => {
    store = {
      accounts: new Map(),
      transactions: [],
      orders: new Map(),
      connections: new Map(),
    };

    // Store state helper
    mockPrisma = {
      $transaction: jest.fn(async (cb) => {
        let appliedBalanceChange = new Decimal(0);
        let updatedAccId: string | null = null;
        let createdTx: any = null;

        const txClient = {
          ...mockPrisma,
          account: {
            update: jest.fn((args) => {
              const acc = store.accounts.get(args.where.id);
              if (args.data.balance?.increment) {
                const inc = new Decimal(args.data.balance.increment.toString());
                appliedBalanceChange = appliedBalanceChange.plus(inc);
                updatedAccId = acc.id;
                acc.balance = new Decimal(acc.balance.toString()).plus(inc).toString();
              }
              if (args.data.totalCredit) acc.totalCredit = args.data.totalCredit;
              if (args.data.totalDebit) acc.totalDebit = args.data.totalDebit;
              return Promise.resolve(acc);
            }),
          },
          transaction: {
            create: jest.fn((args) => {
              if (args.data.clientId) {
                const existing = store.transactions.find((t) => t.clientId === args.data.clientId);
                if (existing) {
                  const error: any = new Error('Unique constraint failed on the fields: (`clientId`)');
                  error.code = 'P2002';
                  throw error;
                }
              }
              const rec = { id: `tx-${Date.now()}-${Math.random()}`, ...args.data };
              createdTx = rec;
              store.transactions.push(rec);
              return Promise.resolve(rec);
            }),
            update: jest.fn((args) => {
              const tx = store.transactions.find((t) => t.id === args.where.id);
              if (tx) {
                Object.assign(tx, args.data);
                return Promise.resolve(tx);
              }
              return Promise.resolve(null);
            }),
          },
        };

        try {
          return await cb(txClient);
        } catch (err) {
          if (updatedAccId && !appliedBalanceChange.isZero()) {
            const acc = store.accounts.get(updatedAccId);
            if (acc) {
              acc.balance = new Decimal(acc.balance.toString()).minus(appliedBalanceChange).toString();
            }
          }
          if (createdTx) {
            const idx = store.transactions.indexOf(createdTx);
            if (idx !== -1) store.transactions.splice(idx, 1);
          }
          throw err;
        }
      }),
      business: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      connection: {
        findFirst: jest.fn((args) => {
          const id = args?.where?.id;
          if (id && store.connections.has(id)) {
            const conn = store.connections.get(id);
            const acc = store.accounts.get(conn.accountId);
            return Promise.resolve({ ...conn, account: acc });
          }
          for (const conn of store.connections.values()) {
            const acc = store.accounts.get(conn.accountId);
            return Promise.resolve({ ...conn, account: acc });
          }
          return Promise.resolve(null);
        }),
      },
      order: {
        findUnique: jest.fn((args) => {
          const o = store.orders.get(args.where.id);
          return Promise.resolve(o || null);
        }),
      },
      account: {
        update: jest.fn((args) => {
          const acc = store.accounts.get(args.where.id);
          if (args.data.balance?.increment) {
            const inc = new Decimal(args.data.balance.increment.toString());
            acc.balance = new Decimal(acc.balance.toString()).plus(inc).toString();
          }
          return Promise.resolve(acc);
        }),
      },
      transaction: {
        findUnique: jest.fn((args) => {
          if (args.where?.clientId) {
            const tx = store.transactions.find((t) => t.clientId === args.where.clientId);
            return Promise.resolve(tx || null);
          }
          if (args.where?.id) {
            const tx = store.transactions.find((t) => t.id === args.where.id);
            return Promise.resolve(tx || null);
          }
          return Promise.resolve(null);
        }),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        FinanceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    transactionsService = module.get<TransactionsService>(TransactionsService);
    financeService = module.get<FinanceService>(FinanceService);
  });

  function setupAccount() {
    const accountId = 'acc-race-1';
    const connId = 'conn-race-1';
    store.accounts.set(accountId, {
      id: accountId,
      balance: '4500.00',
      currency: 'YER',
      totalCredit: '0',
      totalDebit: '0',
    });
    store.connections.set(connId, {
      id: connId,
      accountId,
      connectionType: 'CUSTOMER',
      requesterId: 'merchant-biz',
      receiverId: 'consumer-biz',
      status: 'ACCEPTED',
    });
    return { accountId, connId };
  }

  it('TEST 1: Same clientId — 2 concurrent requests produce 1 transaction and 1 balance mutation (6,500)', async () => {
    const { accountId, connId } = setupAccount();
    const sameClientId = 'concurrent-uuid-same-1';

    const reqDto = {
      amount: '2000.00',
      transactionType: 'SALE',
      connectionId: connId,
      receiverId: 'consumer-biz',
      accountRole: 'CUSTOMER',
      clientId: sameClientId,
    } as any;

    const [res1, res2] = await Promise.all([
      transactionsService.createTransaction('merchant-biz', reqDto),
      transactionsService.createTransaction('merchant-biz', reqDto),
    ]);

    // Both requests return a valid transaction object with same ID
    expect(res1).toBeDefined();
    expect(res2).toBeDefined();
    expect(res1.id).toBe(res2.id);

    // Only 1 transaction in DB
    expect(store.transactions.filter((t) => t.clientId === sameClientId).length).toBe(1);

    // Balance mutated exactly once: 4,500 + 2,000 = 6,500.00 (NOT 8,500.00)
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('6500.00');
  });

  it('TEST 2: Same clientId — 10 concurrent requests produce 1 transaction and 1 balance mutation (6,500)', async () => {
    const { accountId, connId } = setupAccount();
    const sameClientId = 'concurrent-uuid-10-stress';

    const reqDto = {
      amount: '2000.00',
      transactionType: 'SALE',
      connectionId: connId,
      receiverId: 'consumer-biz',
      accountRole: 'CUSTOMER',
      clientId: sameClientId,
    } as any;

    const promises = Array.from({ length: 10 }).map(() =>
      transactionsService.createTransaction('merchant-biz', reqDto),
    );

    const results = await Promise.all(promises);

    expect(results.length).toBe(10);
    // All results reference the exact same transaction ID
    const firstId = results[0].id;
    for (const r of results) {
      expect(r.id).toBe(firstId);
    }

    // Exactly 1 transaction created in DB
    expect(store.transactions.filter((t) => t.clientId === sameClientId).length).toBe(1);

    // Balance mutated exactly once
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('6500.00');
  });

  it('TEST 3: Same clientId — 50 concurrent requests produce 1 transaction and 1 balance mutation (6,500)', async () => {
    const { accountId, connId } = setupAccount();
    const sameClientId = 'concurrent-uuid-50-stress';

    const reqDto = {
      amount: '2000.00',
      transactionType: 'SALE',
      connectionId: connId,
      receiverId: 'consumer-biz',
      accountRole: 'CUSTOMER',
      clientId: sameClientId,
    } as any;

    const promises = Array.from({ length: 50 }).map(() =>
      transactionsService.createTransaction('merchant-biz', reqDto),
    );

    const results = await Promise.all(promises);

    expect(results.length).toBe(50);
    const firstId = results[0].id;
    for (const r of results) {
      expect(r.id).toBe(firstId);
    }

    expect(store.transactions.filter((t) => t.clientId === sameClientId).length).toBe(1);
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('6500.00');
  });

  it('TEST 4: Different clientIds — concurrent requests are both accepted (4,500 + 2,000 + 3,000 = 9,500)', async () => {
    const { accountId, connId } = setupAccount();

    const req1 = {
      amount: '2000.00',
      transactionType: 'SALE',
      connectionId: connId,
      receiverId: 'consumer-biz',
      accountRole: 'CUSTOMER',
      clientId: 'uuid-diff-A',
    } as any;

    const req2 = {
      amount: '3000.00',
      transactionType: 'SALE',
      connectionId: connId,
      receiverId: 'consumer-biz',
      accountRole: 'CUSTOMER',
      clientId: 'uuid-diff-B',
    } as any;

    const [res1, res2] = await Promise.all([
      transactionsService.createTransaction('merchant-biz', req1),
      transactionsService.createTransaction('merchant-biz', req2),
    ]);

    expect(res1.id).not.toBe(res2.id);
    expect(store.transactions.length).toBe(2);
    // 4,500 + 2,000 + 3,000 = 9,500
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('9500.00');
  });

  it('TEST 5: P2002 Handling — Prisma Unique Constraint Conflict gracefully recovers and returns existing transaction', async () => {
    const { accountId, connId } = setupAccount();
    const clientId = 'uuid-p2002-test';

    const reqDto = {
      amount: '1500.00',
      transactionType: 'SALE',
      connectionId: connId,
      receiverId: 'consumer-biz',
      accountRole: 'CUSTOMER',
      clientId,
    } as any;

    // Direct sequential and simulated parallel calls
    const res1 = await transactionsService.createTransaction('merchant-biz', reqDto);
    const res2 = await transactionsService.createTransaction('merchant-biz', reqDto);

    expect(res1.id).toBe(res2.id);
    expect(store.transactions.length).toBe(1);
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('6000.00');
  });
});
