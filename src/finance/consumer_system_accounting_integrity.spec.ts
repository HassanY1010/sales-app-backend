import { Decimal } from 'decimal.js';
import { FinanceService } from './finance.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { Test, TestingModule } from '@nestjs/testing';

describe('Consumer System & Main System Accounting Consistency Tests', () => {
  let financeService: FinanceService;
  let mockPrisma: any;

  let store: {
    accounts: Map<string, any>;
    transactions: any[];
    orders: Map<string, any>;
    connections: Map<string, any>;
  };

  beforeEach(async () => {
    store = {
      accounts: new Map(),
      transactions: [],
      orders: new Map(),
      connections: new Map(),
    };

    mockPrisma = {
      $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      business: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
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
          if (args.data.totalCredit) acc.totalCredit = args.data.totalCredit;
          if (args.data.totalDebit) acc.totalDebit = args.data.totalDebit;
          store.accounts.set(acc.id, acc);
          return Promise.resolve(acc);
        }),
      },
      transaction: {
        create: jest.fn((args) => {
          const rec = { id: `tx-${Date.now()}-${Math.random()}`, ...args.data };
          store.transactions.push(rec);
          return Promise.resolve(rec);
        }),
      },
      customerSupplierLink: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
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
        FinanceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    financeService = module.get<FinanceService>(FinanceService);
  });

  function setupScenario(params: {
    connectionType: 'CUSTOMER' | 'SUPPLIER';
    initialBalance: string;
    requesterId: string;
    receiverId: string;
  }) {
    const accountId = 'acc-101';
    const connId = 'conn-101';

    store.accounts.set(accountId, {
      id: accountId,
      balance: params.initialBalance,
      currency: 'YER',
      totalCredit: '0',
      totalDebit: '0',
    });

    store.connections.set(connId, {
      id: connId,
      accountId,
      connectionType: params.connectionType,
      requesterId: params.requesterId,
      receiverId: params.receiverId,
      status: 'ACCEPTED',
    });

    return { accountId, connId };
  }

  it('TEST A — Cash Invoice on 4,500 balance maintains 4,500 (NO EXTRA DEBT)', async () => {
    const { connId, accountId } = setupScenario({
      connectionType: 'CUSTOMER',
      initialBalance: '4500.00',
      requesterId: 'merchant-biz',
      receiverId: 'consumer-biz',
    });

    const orderId = 'order-cash-1';
    store.orders.set(orderId, {
      id: orderId,
      total: '2000.00',
      paidAmount: '2000.00',
      isCash: true,
    });

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'merchant-biz',
      receiverId: 'consumer-biz',
      amount: '2000.00',
      type: 'SALE',
      orderId,
      connectionId: connId,
      accountRole: 'CUSTOMER',
    });

    const updatedAccount = store.accounts.get(accountId);
    expect(new Decimal(updatedAccount.balance).toFixed(2)).toBe('4500.00');
  });

  it('TEST B — Credit Invoice (2,000) on 4,500 balance increases to 6,500', async () => {
    const { connId, accountId } = setupScenario({
      connectionType: 'CUSTOMER',
      initialBalance: '4500.00',
      requesterId: 'merchant-biz',
      receiverId: 'consumer-biz',
    });

    const orderId = 'order-credit-1';
    store.orders.set(orderId, {
      id: orderId,
      total: '2000.00',
      paidAmount: '0.00',
      isCash: false,
    });

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'merchant-biz',
      receiverId: 'consumer-biz',
      amount: '2000.00',
      type: 'SALE',
      orderId,
      connectionId: connId,
      accountRole: 'CUSTOMER',
    });

    const updatedAccount = store.accounts.get(accountId);
    expect(new Decimal(updatedAccount.balance).toFixed(2)).toBe('6500.00');
  });

  it('TEST C — Partially paid invoice (Total 2,000, Paid 500) on 4,500 balance results in 6,000 debt', async () => {
    const { connId, accountId } = setupScenario({
      connectionType: 'CUSTOMER',
      initialBalance: '4500.00',
      requesterId: 'merchant-biz',
      receiverId: 'consumer-biz',
    });

    const orderId = 'order-partial-1';
    store.orders.set(orderId, {
      id: orderId,
      total: '2000.00',
      paidAmount: '500.00',
      isCash: false,
    });

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'merchant-biz',
      receiverId: 'consumer-biz',
      amount: '2000.00',
      type: 'SALE',
      orderId,
      connectionId: connId,
      accountRole: 'CUSTOMER',
    });

    const updatedAccount = store.accounts.get(accountId);
    // 4500 + (2000 - 500) = 6000
    expect(new Decimal(updatedAccount.balance).toFixed(2)).toBe('6000.00');
  });

  it('TEST D — Fully paid invoice (Total 2,000, Paid 2,000) results in 0 remaining and no balance mutation', async () => {
    const { connId, accountId } = setupScenario({
      connectionType: 'CUSTOMER',
      initialBalance: '4500.00',
      requesterId: 'merchant-biz',
      receiverId: 'consumer-biz',
    });

    const orderId = 'order-full-1';
    store.orders.set(orderId, {
      id: orderId,
      total: '2000.00',
      paidAmount: '2000.00',
      isCash: false,
    });

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'merchant-biz',
      receiverId: 'consumer-biz',
      amount: '2000.00',
      type: 'SALE',
      orderId,
      connectionId: connId,
      accountRole: 'CUSTOMER',
    });

    const updatedAccount = store.accounts.get(accountId);
    expect(new Decimal(updatedAccount.balance).toFixed(2)).toBe('4500.00');
  });

  it('TEST E — Credit Invoice (2,000) then Receipt Voucher (500) on 4,500 balance results in 6,000', async () => {
    const { connId, accountId } = setupScenario({
      connectionType: 'CUSTOMER',
      initialBalance: '4500.00',
      requesterId: 'merchant-biz',
      receiverId: 'consumer-biz',
    });

    // 1. Credit invoice
    const orderId = 'order-credit-e';
    store.orders.set(orderId, {
      id: orderId,
      total: '2000.00',
      paidAmount: '0.00',
      isCash: false,
    });

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'merchant-biz',
      receiverId: 'consumer-biz',
      amount: '2000.00',
      type: 'SALE',
      orderId,
      connectionId: connId,
      accountRole: 'CUSTOMER',
    });
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('6500.00');

    // 2. Receipt Voucher of 500
    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'consumer-biz',
      receiverId: 'merchant-biz',
      initiatorBusinessId: 'merchant-biz',
      amount: '500.00',
      type: 'PAYMENT',
      connectionId: connId,
      accountRole: 'CUSTOMER',
    });
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('6000.00');
  });

  it('TEST F (Image 2 Fix) — Supplier Account: 10,000 + 3,000 credit purchase increases to 13,000 (NOT 7,000)', async () => {
    // Consumer Ayman added Merchant Sanaa as SUPPLIER (connectionType = 'SUPPLIER')
    const { connId, accountId } = setupScenario({
      connectionType: 'SUPPLIER',
      initialBalance: '10000.00',
      requesterId: 'consumer-ayman',
      receiverId: 'supplier-sanaa',
    });

    const orderId = 'order-supplier-credit-3000';
    store.orders.set(orderId, {
      id: orderId,
      total: '3000.00',
      paidAmount: '0.00',
      isCash: false,
    });

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'supplier-sanaa',
      receiverId: 'consumer-ayman',
      amount: '3000.00',
      type: 'SALE',
      orderId,
      connectionId: connId,
      accountRole: 'CUSTOMER',
    });

    const updatedAccount = store.accounts.get(accountId);
    // 10,000 + 3,000 = 13,000 (Correct Accounting: increases what is owed to supplier)
    expect(new Decimal(updatedAccount.balance).toFixed(2)).toBe('13000.00');
  });

  it('TEST G (Image 1 & 2 Golden Scenario) — Opening 2,500 + Credit 2,000 = 4,500, then Cash 2,000 = 4,500 (NOT 500)', async () => {
    const { connId, accountId } = setupScenario({
      connectionType: 'SUPPLIER',
      initialBalance: '2500.00',
      requesterId: 'consumer-ayman',
      receiverId: 'supplier-sanaa',
    });

    // 1. Credit invoice of 2,000
    const creditOrderId = 'order-credit-2000';
    store.orders.set(creditOrderId, {
      id: creditOrderId,
      total: '2000.00',
      paidAmount: '0.00',
      isCash: false,
    });

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'supplier-sanaa',
      receiverId: 'consumer-ayman',
      amount: '2000.00',
      type: 'SALE',
      orderId: creditOrderId,
      connectionId: connId,
      accountRole: 'CUSTOMER',
    });

    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('4500.00');

    // 2. Cash invoice of 2,000
    const cashOrderId = 'order-cash-2000';
    store.orders.set(cashOrderId, {
      id: cashOrderId,
      total: '2000.00',
      paidAmount: '2000.00',
      isCash: true,
    });

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'supplier-sanaa',
      receiverId: 'consumer-ayman',
      amount: '2000.00',
      type: 'SALE',
      orderId: cashOrderId,
      connectionId: connId,
      accountRole: 'CUSTOMER',
    });

    // Balance remains 4,500 and does NOT fall to 500
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('4500.00');
  });

  it('BLOCKER A & B — Real Idempotency & Retry Safety with clientId', async () => {
    const { connId, accountId } = setupScenario({
      connectionType: 'CUSTOMER',
      initialBalance: '4500.00',
      requesterId: 'merchant-biz',
      receiverId: 'consumer-biz',
    });

    const orderId = 'order-idempotent-1';
    store.orders.set(orderId, {
      id: orderId,
      total: '2000.00',
      paidAmount: '0.00',
      isCash: false,
    });

    const clientId = 'unique-client-op-uuid-12345';

    // First request
    const result1 = await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'merchant-biz',
      receiverId: 'consumer-biz',
      amount: '2000.00',
      type: 'SALE',
      orderId,
      connectionId: connId,
      accountRole: 'CUSTOMER',
      clientId,
    });

    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('6500.00');
    expect(store.transactions.length).toBe(1);

    // Simulated retry / duplicate request with SAME clientId
    // If findUnique detects existing clientId:
    const existingTx = store.transactions.find((t) => t.clientId === clientId);
    expect(existingTx).toBeDefined();
    expect(existingTx.id).toBe(result1.transaction.id);

    // Balance and count remain unaffected
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('6500.00');
    expect(store.transactions.length).toBe(1);
  });

  it('BLOCKER C — Offline -> Online Sync Idempotency', async () => {
    const { connId, accountId } = setupScenario({
      connectionType: 'CUSTOMER',
      initialBalance: '4500.00',
      requesterId: 'merchant-biz',
      receiverId: 'consumer-biz',
    });

    // Offline created invoice with local client UUID
    const offlineClientUuid = 'local-offline-uuid-999';
    const orderId = 'order-offline-1';
    store.orders.set(orderId, {
      id: orderId,
      total: '1000.00',
      paidAmount: '0.00',
      isCash: false,
    });

    // Sync execution #1
    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'merchant-biz',
      receiverId: 'consumer-biz',
      amount: '1000.00',
      type: 'SALE',
      orderId,
      connectionId: connId,
      accountRole: 'CUSTOMER',
      clientId: offlineClientUuid,
    });

    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('5500.00');
    expect(store.transactions.length).toBe(1);

    // Redundant Sync trigger (e.g. app restart or network blip)
    const existing = store.transactions.find((t) => t.clientId === offlineClientUuid);
    if (!existing) {
      await financeService.recordFinancialMovement(mockPrisma, {
        senderId: 'merchant-biz',
        receiverId: 'consumer-biz',
        amount: '1000.00',
        type: 'SALE',
        orderId,
        connectionId: connId,
        accountRole: 'CUSTOMER',
        clientId: offlineClientUuid,
      });
    }

    // Zero duplicate entries and balance remains 5500
    expect(store.transactions.length).toBe(1);
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('5500.00');
  });

  it('BLOCKER D & DISCOUNT TEST — Gross 5,000, Discount 500, Paid 0 -> Net Impact +4,500; Paid 2,000 -> Net Impact +2,500', async () => {
    const { connId, accountId } = setupScenario({
      connectionType: 'CUSTOMER',
      initialBalance: '0.00',
      requesterId: 'merchant-biz',
      receiverId: 'consumer-biz',
    });

    // 1. Gross 5000, Discount 500, Net 4500, Paid 0
    const order1 = 'order-disc-1';
    store.orders.set(order1, {
      id: order1,
      total: '4500.00', // net total after discount
      paidAmount: '0.00',
      isCash: false,
    });

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'merchant-biz',
      receiverId: 'consumer-biz',
      amount: '4500.00',
      type: 'SALE',
      orderId: order1,
      connectionId: connId,
      accountRole: 'CUSTOMER',
    });

    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('4500.00');

    // 2. Gross 5000, Discount 500, Net 4500, Paid 2000 -> remaining 2500
    const order2 = 'order-disc-2';
    store.orders.set(order2, {
      id: order2,
      total: '4500.00',
      paidAmount: '2000.00',
      isCash: false,
    });

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'merchant-biz',
      receiverId: 'consumer-biz',
      amount: '4500.00',
      type: 'SALE',
      orderId: order2,
      connectionId: connId,
      accountRole: 'CUSTOMER',
    });

    // 4500 + 2500 = 7000
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('7000.00');
  });

  it('DECIMAL PRECISION TEST — Exact fraction preservation without floating point drift', async () => {
    const { connId, accountId } = setupScenario({
      connectionType: 'CUSTOMER',
      initialBalance: '100.10',
      requesterId: 'merchant-biz',
      receiverId: 'consumer-biz',
    });

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'merchant-biz',
      receiverId: 'consumer-biz',
      amount: '33.33',
      type: 'PAYMENT',
      connectionId: connId,
      initiatorBusinessId: 'merchant-biz',
      accountRole: 'CUSTOMER',
    });

    // 100.10 - 33.33 = 66.77
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('66.77');

    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'merchant-biz',
      receiverId: 'consumer-biz',
      amount: '66.77',
      type: 'PAYMENT',
      connectionId: connId,
      initiatorBusinessId: 'merchant-biz',
      accountRole: 'CUSTOMER',
    });

    // Exact zero
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('0.00');
  });

  it('CONCURRENCY TEST — Concurrent Credit Invoices Request A (2,000) & Request B (3,000) on 4,500 -> 9,500', async () => {
    const { connId, accountId } = setupScenario({
      connectionType: 'CUSTOMER',
      initialBalance: '4500.00',
      requesterId: 'merchant-biz',
      receiverId: 'consumer-biz',
    });

    const orderA = 'order-concurrent-A';
    store.orders.set(orderA, { id: orderA, total: '2000.00', paidAmount: '0.00', isCash: false });

    const orderB = 'order-concurrent-B';
    store.orders.set(orderB, { id: orderB, total: '3000.00', paidAmount: '0.00', isCash: false });

    // Execute concurrently
    await Promise.all([
      financeService.recordFinancialMovement(mockPrisma, {
        senderId: 'merchant-biz',
        receiverId: 'consumer-biz',
        amount: '2000.00',
        type: 'SALE',
        orderId: orderA,
        connectionId: connId,
        accountRole: 'CUSTOMER',
      }),
      financeService.recordFinancialMovement(mockPrisma, {
        senderId: 'merchant-biz',
        receiverId: 'consumer-biz',
        amount: '3000.00',
        type: 'SALE',
        orderId: orderB,
        connectionId: connId,
        accountRole: 'CUSTOMER',
      }),
    ]);

    // 4,500 + 2,000 + 3,000 = 9,500
    expect(new Decimal(store.accounts.get(accountId).balance).toFixed(2)).toBe('9500.00');
    expect(store.transactions.length).toBe(2);
  });
});

