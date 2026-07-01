import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PayoutStatus, CommissionStatus, Prisma } from '@prisma/client';

@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Secure payout transaction block to disburse accumulated commissions.
   * Executes in a single database transaction context to avoid double payout issues.
   */
  async createPayout(agentId: string, notes?: string, receiptUrl?: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      include: { user: { select: { fullName: true, id: true } } },
    });

    if (!agent) {
      throw new NotFoundException('المندوب المحدد غير موجود.');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Fetch all pending or approved commissions to lock them
      const commissions = await tx.commission.findMany({
        where: {
          agentId,
          status: { in: [CommissionStatus.PENDING, CommissionStatus.APPROVED] },
        },
      });

      if (commissions.length === 0) {
        throw new BadRequestException(
          'لا يوجد عمولات معلقة أو معتمدة لصرفها لهذا المندوب.',
        );
      }

      // 2. Sum amounts
      let totalAmount = new Prisma.Decimal(0);
      for (const comm of commissions) {
        totalAmount = totalAmount.add(comm.amount);
      }

      // 3. Create the CommissionPayout record
      const payout = await tx.commissionPayout.create({
        data: {
          agentId,
          totalAmount,
          status: PayoutStatus.PAID,
          notes: notes || `صرف عمولة مبيعات للمندوب ${agent.user.fullName}`,
          receiptUrl: receiptUrl || null,
          paidAt: new Date(),
        },
      });

      // 4. Update all selected commissions to PAID and associate them with this payout
      await tx.commission.updateMany({
        where: {
          id: { in: commissions.map((c) => c.id) },
        },
        data: {
          status: CommissionStatus.PAID,
          payoutId: payout.id,
        },
      });

      // 5. Send real-time notification to the agent
      const amountNum = totalAmount.toNumber();
      const title = '💸 تم صرف عمولاتك!';
      const body = `تم صرف مبلغ ${amountNum.toLocaleString()} ر.ي. عمولات مستحقة لك. شكراً لتعاونك معنا!`;

      await tx.notification.create({
        data: {
          userId: agent.userId,
          title,
          body,
          type: 'PAYOUT_COMPLETED',
        },
      });

      setTimeout(async () => {
        try {
          await this.notificationsService.sendPushNotification(
            agent.userId,
            title,
            body,
            {
              type: 'PAYOUT_COMPLETED',
              payoutId: payout.id,
              amount: amountNum.toString(),
            },
          );
        } catch (e) {
          // Silent notification catch
        }
      }, 100);

      return payout;
    });
  }

  async findAll(agentId?: string) {
    const where: any = {};
    if (agentId) where.agentId = agentId;

    return this.prisma.commissionPayout.findMany({
      where,
      include: {
        agent: {
          include: {
            user: {
              select: {
                fullName: true,
                phoneNumber: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const payout = await this.prisma.commissionPayout.findUnique({
      where: { id },
      include: {
        agent: {
          include: {
            user: { select: { fullName: true } },
          },
        },
        commissions: true,
      },
    });
    if (!payout) {
      throw new NotFoundException('سجل الصرف المطلوب غير موجود.');
    }
    return payout;
  }
}
