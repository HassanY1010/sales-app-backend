import { BadRequestException } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { FinanceService } from './finance.service';

describe('FinanceService ledger movements', () => {
  const requesterId = 'business-requester';
  const receiverId = 'business-receiver';
  const accountId = 'account-1';

  const prisma = {
    business: {
      findUnique: jest.fn(),
    },
    account: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    transaction: {
      findMany: jest.fn(),
    },
  };

  const notifications = {
    sendPushNotification: jest.fn(),
  };

  const events = {
    emitToBusiness: jest.fn(),
  };

  function createTx(initialBalance = '0') {
    let balance = new Decimal(initialBalance);
    const tx = {
      connection: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'connection-1',
          requesterId,
          receiverId,
          account: {
            id: accountId,
            balance: balance.toString(),
            currency: 'YER',
            dueDate: null,
          },
        }),
      },
      account: {
        update: jest.fn(async ({ data }: any) => {
          if (data.balance?.increment !== undefined) {
            balance = balance.plus(new Decimal(data.balance.increment));
          }
          return {
            id: accountId,
            balance: balance.toString(),
          };
        }),
      },
      transaction: {
        create: jest.fn(async ({ data }: any) => ({
          id: 'transaction-1',
          ...data,
        })),
      },
      auditLog: {
        create: jest.fn(),
      },
    };

    return { tx, getBalance: () => balance };
  }

  let service: FinanceService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.business.findUnique.mockImplementation(({ where, include }: any) => {
      if (where.id === requesterId) {
        return Promise.resolve({
          id: requesterId,
          name: 'Requester',
          ...(include?.user ? { user: { id: 'requester-user' } } : {}),
        });
      }
      if (where.id === receiverId) {
        return Promise.resolve({
          id: receiverId,
          name: 'Receiver',
          ...(include?.user ? { user: { id: 'receiver-user' } } : {}),
        });
      }
      return Promise.resolve(null);
    });
    service = new FinanceService(
      prisma as any,
      notifications as any,
      events as any,
    );
  });

  it('increases requester-perspective balance when requester sells to receiver', async () => {
    const { tx, getBalance } = createTx('0');

    const result = await service.recordFinancialMovement(tx as any, {
      senderId: requesterId,
      receiverId,
      amount: '100.50',
      type: 'SALE',
    });

    expect(getBalance().toString()).toBe('-100.5');
    expect(result.newBalance.toString()).toBe('-100.5');
    expect(tx.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        transactionType: 'SALE',
        amount: '100.5',
        senderId: requesterId,
        receiverId,
        balanceAfter: '-100.5',
      }),
    });
    expect(tx.account.update).toHaveBeenLastCalledWith({
      where: { id: accountId },
      data: { totalCredit: '0', totalDebit: '100.5' },
    });
  });

  it('reduces requester debt when requester pays receiver', async () => {
    const { tx, getBalance } = createTx('-100');

    await service.recordFinancialMovement(tx as any, {
      senderId: requesterId,
      receiverId,
      amount: '40',
      type: 'PAYMENT',
    });

    expect(getBalance().toString()).toBe('-60');
    expect(tx.account.update).toHaveBeenLastCalledWith({
      where: { id: accountId },
      data: { totalCredit: '0', totalDebit: '60' },
    });
  });

  it('reduces receiver debt when receiver pays requester', async () => {
    const { tx, getBalance } = createTx('100');

    await service.recordFinancialMovement(tx as any, {
      senderId: receiverId,
      receiverId: requesterId,
      amount: '25',
      type: 'PAYMENT',
    });

    expect(getBalance().toString()).toBe('75');
    expect(tx.account.update).toHaveBeenLastCalledWith({
      where: { id: accountId },
      data: { totalCredit: '75', totalDebit: '0' },
    });
  });

  it('rejects transactions within the same business', async () => {
    const { tx } = createTx('0');

    await expect(
      service.recordFinancialMovement(tx as any, {
        senderId: requesterId,
        receiverId: requesterId,
        amount: '10',
        type: 'ADJUSTMENT',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.transaction.create).not.toHaveBeenCalled();
  });

  it('rebuilds account balance from ledger entries', async () => {
    prisma.account.findUnique.mockResolvedValue({
      id: accountId,
      connection: { requesterId, receiverId },
    });
    prisma.transaction.findMany.mockResolvedValue([
      {
        senderId: requesterId,
        receiverId,
        transactionType: 'SALE',
        amount: '100',
      },
      {
        senderId: receiverId,
        receiverId: requesterId,
        transactionType: 'PAYMENT',
        amount: '30',
      },
      {
        senderId: receiverId,
        receiverId: requesterId,
        transactionType: 'ADJUSTMENT',
        amount: '10',
      },
    ]);
    prisma.account.update.mockResolvedValue({});

    await service.rebuildAccountBalance(accountId);

    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: {
        balance: '-140',
        totalCredit: '0',
        totalDebit: '140',
      },
    });
  });
});
