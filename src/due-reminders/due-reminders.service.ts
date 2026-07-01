import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

type DueReminderResult = {
  scanned: number;
  sent: number;
  skipped: number;
};

@Injectable()
export class DueRemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DueRemindersService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    if (this.configService.get<string>('DUE_REMINDERS_ENABLED') === 'false') {
      this.logger.log('Due reminders scheduler disabled');
      return;
    }

    const minutes = Number(
      this.configService.get<string>('DUE_REMINDER_INTERVAL_MINUTES') || '60',
    );
    const intervalMs = Math.max(minutes, 5) * 60 * 1000;

    this.timer = setInterval(() => {
      void this.processDueReminders().catch((error) => {
        this.logger.error(
          `Due reminders job failed: ${error.message}`,
          error.stack,
        );
      });
    }, intervalMs);
    this.timer.unref?.();

    void this.processDueReminders().catch((error) => {
      this.logger.error(
        `Initial due reminders job failed: ${error.message}`,
        error.stack,
      );
    });
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async processDueReminders(now = new Date()): Promise<DueReminderResult> {
    if (this.running) {
      return { scanned: 0, sent: 0, skipped: 0 };
    }

    this.running = true;
    try {
      const reminderDate = this.startOfDay(now);
      const dueConnections = await this.prisma.connection.findMany({
        where: {
          status: 'ACCEPTED',
          account: {
            dueDate: { lte: now },
            NOT: { balance: 0 },
          },
        },
        include: {
          account: true,
          requester: { include: { user: true } },
          receiver: { include: { user: true } },
        },
      });

      let sent = 0;
      let skipped = 0;

      for (const connection of dueConnections) {
        if (!connection.account?.dueDate) {
          skipped += 1;
          continue;
        }

        const balance = new Decimal(connection.account.balance as any);
        if (balance.isZero()) {
          skipped += 1;
          continue;
        }

        const debtorBusiness = balance.greaterThan(0)
          ? connection.receiver
          : connection.requester;
        const creditorBusiness = balance.greaterThan(0)
          ? connection.requester
          : connection.receiver;
        const amount = balance.abs();

        const created = await this.createReminderLogOnce({
          connectionId: connection.id,
          accountId: connection.account.id,
          recipientBusinessId: debtorBusiness.id,
          reminderDate,
          dueDate: connection.account.dueDate,
          amount,
          direction: balance.greaterThan(0)
            ? 'RECEIVER_OWES_REQUESTER'
            : 'REQUESTER_OWES_RECEIVER',
        });

        if (!created) {
          skipped += 1;
          continue;
        }

        await this.notificationsService.notifyUser(
          debtorBusiness.user.id,
          'تذكير بموعد سداد مستحق',
          `يوجد مبلغ مستحق قدره ${amount.toFixed(2)} لصالح ${creditorBusiness.name}. يرجى تسوية الحساب.`,
          {
            type: 'DUE_PAYMENT_REMINDER',
            connectionId: connection.id,
            accountId: connection.account.id,
            dueDate: connection.account.dueDate.toISOString(),
            amount: amount.toString(),
          },
        );
        sent += 1;
      }

      if (dueConnections.length > 0) {
        this.logger.log(
          `Due reminders scanned=${dueConnections.length} sent=${sent} skipped=${skipped}`,
        );
      }

      return { scanned: dueConnections.length, sent, skipped };
    } finally {
      this.running = false;
    }
  }

  private async createReminderLogOnce(params: {
    connectionId: string;
    accountId: string;
    recipientBusinessId: string;
    reminderDate: Date;
    dueDate: Date;
    amount: Decimal;
    direction: string;
  }) {
    try {
      await this.prisma.dueReminderLog.create({
        data: {
          connectionId: params.connectionId,
          accountId: params.accountId,
          recipientBusinessId: params.recipientBusinessId,
          reminderDate: params.reminderDate,
          dueDate: params.dueDate,
          amount: params.amount.toString(),
          direction: params.direction,
        },
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
  }

  private startOfDay(date: Date) {
    const result = new Date(date);
    result.setHours(0, 0, 0, 0);
    return result;
  }
}
