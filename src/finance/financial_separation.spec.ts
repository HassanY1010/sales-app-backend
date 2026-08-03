import { Test, TestingModule } from '@nestjs/testing';
import { FinanceService } from './finance.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import Decimal from 'decimal.js';

describe('Financial Separation - Dual Role Accounts (Same Counterparty)', () => {
  let service: FinanceService;

  const myBusinessId = 'my-biz-111';
  const ahmadBusinessId = 'ahmad-biz-222';

  const customerConnectionId = 'conn-customer-999';
  const supplierConnectionId = 'conn-supplier-888';

  const customerAccountId = 'acc-customer-111';
  const supplierAccountId = 'acc-supplier-222';

  // In-memory mock store for dual role test
  let transactionsStore: any[] = [];
  let accountsStore: Record<string, any> = {};

  const mockPrismaService = {
    business: {
      findUnique: jest.fn().mockImplementation(({ where }) => ({
        id: where.id,
        name: where.id === myBusinessId ? 'متجري' : 'بقالة الأمانة',
        user: { id: `user-${where.id}`, fullName: 'أحمد' },
      })),
    },
    connection: {
      findFirst: jest.fn().mockImplementation(({ where }) => {
        if (where?.id === customerConnectionId || (where?.OR && where?.OR[0]?.connectionType === 'CUSTOMER')) {
          return {
            id: customerConnectionId,
            requesterId: myBusinessId,
            receiverId: ahmadBusinessId,
            connectionType: 'CUSTOMER',
            account: accountsStore[customerAccountId],
          };
        }
        if (where?.id === supplierConnectionId || (where?.OR && where?.OR[0]?.connectionType === 'SUPPLIER')) {
          return {
            id: supplierConnectionId,
            requesterId: myBusinessId,
            receiverId: ahmadBusinessId,
            connectionType: 'SUPPLIER',
            account: accountsStore[supplierAccountId],
          };
        }
        return null;
      }),
    },
    account: {
      findUnique: jest.fn().mockImplementation(({ where, include }) => {
        if (where.id === customerAccountId) {
          return {
            ...accountsStore[customerAccountId],
            connection: {
              id: customerConnectionId,
              requesterId: myBusinessId,
              receiverId: ahmadBusinessId,
              connectionType: 'CUSTOMER',
            },
          };
        }
        if (where.id === supplierAccountId) {
          return {
            ...accountsStore[supplierAccountId],
            connection: {
              id: supplierConnectionId,
              requesterId: myBusinessId,
              receiverId: ahmadBusinessId,
              connectionType: 'SUPPLIER',
            },
          };
        }
        return null;
      }),
      update: jest.fn().mockImplementation(({ where, data }) => {
        if (accountsStore[where.id]) {
          let currentBalance = new Decimal(accountsStore[where.id].balance || 0);
          if (data.balance?.increment !== undefined) {
            currentBalance = currentBalance.plus(new Decimal(data.balance.increment));
          } else if (data.balance !== undefined) {
            currentBalance = new Decimal(data.balance);
          }
          accountsStore[where.id] = {
            ...accountsStore[where.id],
            ...data,
            balance: currentBalance,
          };
        }
        return accountsStore[where.id];
      }),
    },
    transaction: {
      create: jest.fn().mockImplementation(({ data }) => {
        const entry = {
          id: `tx-${transactionsStore.length + 1}`,
          ...data,
          createdAt: new Date(),
        };
        transactionsStore.push(entry);
        return entry;
      }),
      findMany: jest.fn().mockImplementation(({ where }) => {
        const targetConnId = where?.OR?.find((item: any) => item.connectionId)?.connectionId;
        if (targetConnId) {
          return transactionsStore.filter((t) => t.connectionId === targetConnId);
        }
        return transactionsStore;
      }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
    $transaction: jest.fn().mockImplementation((cb) => cb(mockPrismaService)),
  };

  beforeEach(async () => {
    transactionsStore = [];
    accountsStore = {
      [customerAccountId]: {
        id: customerAccountId,
        connectionId: customerConnectionId,
        balance: new Decimal(0),
        totalCredit: new Decimal(0),
        totalDebit: new Decimal(0),
        currency: 'YER',
        dueDate: null,
      },
      [supplierAccountId]: {
        id: supplierAccountId,
        connectionId: supplierConnectionId,
        balance: new Decimal(0),
        totalCredit: new Decimal(0),
        totalDebit: new Decimal(0),
        currency: 'YER',
        dueDate: null,
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinanceService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: NotificationsService, useValue: { sendPushNotification: jest.fn() } },
        { provide: EventsGateway, useValue: { emitToBusiness: jest.fn() } },
      ],
    }).compile();

    service = module.get<FinanceService>(FinanceService);
  });

  it('should maintain 100% independent balances and ledger statements for Customer vs Supplier accounts of Ahmad', async () => {
    // 1. Opening balance for Ahmad as Customer = 50,000 (debtor)
    await service.recordFinancialMovement(mockPrismaService as any, {
      senderId: myBusinessId,
      receiverId: ahmadBusinessId,
      connectionId: customerConnectionId,
      amount: 50000,
      type: 'ADJUSTMENT',
      note: 'رصيد افتتاحي للعميل',
    });

    // 2. Opening balance for Ahmad as Supplier = 30,000 (creditor)
    await service.recordFinancialMovement(mockPrismaService as any, {
      senderId: myBusinessId,
      receiverId: ahmadBusinessId,
      connectionId: supplierConnectionId,
      amount: 30000,
      type: 'ADJUSTMENT',
      note: 'رصيد افتتاحي للمورد',
    });

    // 3. Sales Invoice to Ahmad (Customer) = 20,000
    await service.recordFinancialMovement(mockPrismaService as any, {
      senderId: myBusinessId,
      receiverId: ahmadBusinessId,
      connectionId: customerConnectionId,
      amount: 20000,
      type: 'SALE',
      note: 'فاتورة مبيعات',
    });

    // 4. Purchase Invoice from Ahmad (Supplier) = 10,000
    await service.recordFinancialMovement(mockPrismaService as any, {
      senderId: myBusinessId,
      receiverId: ahmadBusinessId,
      connectionId: supplierConnectionId,
      amount: 10000,
      type: 'PURCHASE',
      note: 'فاتورة مشتريات',
    });

    // 5. Receipt Voucher from Ahmad (Customer) = 5,000
    await service.recordFinancialMovement(mockPrismaService as any, {
      senderId: ahmadBusinessId,
      receiverId: myBusinessId,
      connectionId: customerConnectionId,
      amount: 5000,
      type: 'PAYMENT',
      note: 'سند قبض عميل',
    });

    // 6. Payment Voucher to Ahmad (Supplier) = 3,000
    await service.recordFinancialMovement(mockPrismaService as any, {
      senderId: myBusinessId,
      receiverId: ahmadBusinessId,
      connectionId: supplierConnectionId,
      amount: 3000,
      type: 'PAYMENT',
      note: 'سند صرف مورد',
    });

    // Rebuild Customer Account Balance
    await service.rebuildAccountBalance(customerAccountId);
    const customerAccount = accountsStore[customerAccountId];

    // Rebuild Supplier Account Balance
    await service.rebuildAccountBalance(supplierAccountId);
    const supplierAccount = accountsStore[supplierAccountId];

    // Verification of Customer Account:
    // Opening 50,000 + Sale 20,000 - Payment 5,000 = 65,000 (debtor / عليه)
    expect(Number(customerAccount.balance)).toBe(65000);
    expect(Number(customerAccount.totalDebit)).toBe(65000);
    expect(Number(customerAccount.totalCredit)).toBe(0);

    // Verification of Supplier Account:
    // Opening 30,000 + Purchase 10,000 - Payment 3,000 = 37,000 (creditor / له)
    expect(Number(supplierAccount.balance)).toBe(37000);
    expect(Number(supplierAccount.totalCredit)).toBe(37000);
    expect(Number(supplierAccount.totalDebit)).toBe(0);

    // Verify complete ledger isolation (transactions filtering by connectionId)
    const customerTx = transactionsStore.filter((t) => t.connectionId === customerConnectionId);
    const supplierTx = transactionsStore.filter((t) => t.connectionId === supplierConnectionId);

    expect(customerTx.length).toBe(3);
    expect(customerTx.map((t) => t.note)).toEqual([
      'رصيد افتتاحي للعميل',
      'فاتورة مبيعات',
      'سند قبض عميل',
    ]);

    expect(supplierTx.length).toBe(3);
    expect(supplierTx.map((t) => t.note)).toEqual([
      'رصيد افتتاحي للمورد',
      'فاتورة مشتريات',
      'سند صرف مورد',
    ]);
  });
});
