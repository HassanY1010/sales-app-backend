import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommissionStatus, Prisma } from '@prisma/client';

@Injectable()
export class CommissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Main engine trigger for calculation of commission.
   * Executed within a transactional database context.
   */
  async processSubscriptionCommission(
    tx: Prisma.TransactionClient,
    paymentRequestId: string,
    subscriptionId: string,
    userId: string,
    amountPaid: number,
  ) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { referredByAgentId: true, fullName: true },
    });

    if (!user || !user.referredByAgentId) {
      return null; // Silent skip if user was not referred
    }

    const agentId = user.referredByAgentId;

    // Prevent duplicates: Check if a commission for this payment already exists
    const existing = await tx.commission.findFirst({
      where: { paymentRequestId },
    });
    if (existing) {
      return existing; // Skip processing and return existing commission record
    }

    const agent = await tx.agent.findUnique({
      where: { id: agentId },
      include: { user: { select: { fullName: true } } },
    });

    if (!agent || agent.status !== 'ACTIVE') {
      return null; // Skip if agent profile is deactivated/blocked
    }

    // 1. Calculate amount
    let amount = new Prisma.Decimal(0);
    const commissionPercentText = agent.commissionType === 'PERCENTAGE' 
      ? `${agent.commissionValue.toString()}%`
      : 'ثابتة';

    if (agent.commissionType === 'PERCENTAGE') {
      const percentage = agent.commissionValue.div(100);
      amount = new Prisma.Decimal(amountPaid).mul(percentage);
    } else if (agent.commissionType === 'FIXED') {
      amount = agent.commissionValue;
    }

    // Formulate highly detailed commission ledger entry description in Arabic
    const calculationDate = new Date();
    const formattedNotes = 
      `سجل عمولة تلقائي:\n` +
      `- اسم المندوب: ${agent.user.fullName}\n` +
      `- اسم المشترك: ${user.fullName}\n` +
      `- رقم الاشتراك: ${subscriptionId}\n` +
      `- رقم عملية الدفع: ${paymentRequestId}\n` +
      `- قيمة الاشتراك: ${amountPaid.toLocaleString()} ر.ي.\n` +
      `- نسبة/نوع العمولة: ${commissionPercentText}\n` +
      `- قيمة العمولة المستحقة: ${amount.toNumber().toLocaleString()} ر.ي.\n` +
      `- تاريخ الاحتساب: ${calculationDate.toISOString()}`;

    // 2. Persist Commission record
    const commission = await tx.commission.create({
      data: {
        agentId,
        customerId: userId,
        subscriptionId,
        paymentRequestId,
        amount,
        status: CommissionStatus.PENDING,
        notes: formattedNotes,
      },
    });

    // 3. Notify the agent in real-time
    const amountNum = amount.toNumber();
    const title = '🎉 عمولة جديدة مضافة!';
    const body = `تم احتساب عمولة مبيعات جديدة في حسابك بقيمة ${amountNum.toLocaleString()} ر.ي. في انتظار المراجعة والصرف.`;

    await tx.notification.create({
      data: {
        userId: agent.userId,
        title,
        body,
        type: 'NEW_COMMISSION',
      },
    });

    // We trigger FCM and Live Socket updates asynchronously after the transaction commits successfully
    // to avoid blocking the main transaction sequence.
    setTimeout(async () => {
      try {
        await this.notificationsService.sendPushNotification(
          agent.userId,
          title,
          body,
          {
            type: 'NEW_COMMISSION',
            amount: amountNum.toString(),
            commissionId: commission.id,
          },
        );
      } catch (err) {
        // Log notification errors without throwing transaction errors
      }
    }, 100);

    return commission;
  }

  async findAll(filters?: { agentId?: string; status?: CommissionStatus }) {
    const whereClause: any = {};
    if (filters?.agentId) whereClause.agentId = filters.agentId;
    if (filters?.status) whereClause.status = filters.status;

    return this.prisma.commission.findMany({
      where: whereClause,
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
        customer: {
          select: {
            fullName: true,
            phoneNumber: true,
          },
        },
        subscription: {
          include: {
            plan: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const commission = await this.prisma.commission.findUnique({
      where: { id },
      include: {
        agent: {
          include: {
            user: { select: { fullName: true } },
          },
        },
        customer: {
          select: { fullName: true },
        },
      },
    });
    if (!commission) {
      throw new NotFoundException('العمولة المطلوبة غير موجودة.');
    }
    return commission;
  }

  async updateStatus(id: string, status: CommissionStatus, notes?: string) {
    const commission = await this.findOne(id);

    if (commission.status === CommissionStatus.PAID) {
      throw new BadRequestException(
        'لا يمكن تعديل حالة عمولة تم صرفها مسبقاً.',
      );
    }

    return this.prisma.commission.update({
      where: { id },
      data: {
        status,
        notes: notes || commission.notes,
      },
    });
  }
}
