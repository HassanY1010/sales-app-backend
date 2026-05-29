import { Prisma } from '@prisma/client';
import { DueRemindersService } from './due-reminders.service';

describe('DueRemindersService', () => {
  const requester = {
    id: 'requester-business',
    name: 'Requester Store',
    user: { id: 'requester-user' },
  };
  const receiver = {
    id: 'receiver-business',
    name: 'Receiver Store',
    user: { id: 'receiver-user' },
  };

  const prisma = {
    connection: {
      findMany: jest.fn(),
    },
    dueReminderLog: {
      create: jest.fn(),
    },
  };

  const notifications = {
    notifyUser: jest.fn(),
  };

  const config = {
    get: jest.fn(),
  };

  let service: DueRemindersService;

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue('false');
    service = new DueRemindersService(prisma as any, notifications as any, config as any);
  });

  it('sends due reminders to the debtor business and records a once-per-day log', async () => {
    const dueDate = new Date('2026-05-01T08:00:00.000Z');
    prisma.connection.findMany.mockResolvedValue([
      {
        id: 'connection-1',
        account: {
          id: 'account-1',
          balance: '150.25',
          dueDate,
        },
        requester,
        receiver,
      },
    ]);
    prisma.dueReminderLog.create.mockResolvedValue({});

    const result = await service.processDueReminders(new Date('2026-05-26T09:00:00.000Z'));

    expect(result).toEqual({ scanned: 1, sent: 1, skipped: 0 });
    expect(prisma.dueReminderLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        connectionId: 'connection-1',
        accountId: 'account-1',
        recipientBusinessId: receiver.id,
        amount: '150.25',
        direction: 'RECEIVER_OWES_REQUESTER',
      }),
    });
    expect(notifications.notifyUser).toHaveBeenCalledWith(
      receiver.user.id,
      'تذكير بموعد سداد مستحق',
      expect.stringContaining('150.25'),
      expect.objectContaining({ type: 'DUE_PAYMENT_REMINDER' }),
    );
  });

  it('skips duplicate reminders already logged for the same day', async () => {
    prisma.connection.findMany.mockResolvedValue([
      {
        id: 'connection-1',
        account: {
          id: 'account-1',
          balance: '-80',
          dueDate: new Date('2026-05-01T08:00:00.000Z'),
        },
        requester,
        receiver,
      },
    ]);
    prisma.dueReminderLog.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const result = await service.processDueReminders(new Date('2026-05-26T10:00:00.000Z'));

    expect(result).toEqual({ scanned: 1, sent: 0, skipped: 1 });
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });
});
