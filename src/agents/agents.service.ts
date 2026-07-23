import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AgentStatus, CommissionType, Prisma } from '@prisma/client';
import * as crypto from 'crypto';

import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private generateCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = 'REF-';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length];
    }
    return code;
  }

  async create(
    userId: string,
    regionId?: string,
    commissionType?: CommissionType,
    commissionValue?: number,
    customReferralCode?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('المستخدم غير موجود.');

    const existing = await this.prisma.agent.findUnique({ where: { userId } });
    if (existing)
      throw new ConflictException('هذا المستخدم مسجل بالفعل كمندوب.');

    // Use provided code, or auto-generate a unique one
    let referralCode = customReferralCode
      ? customReferralCode.toUpperCase().trim()
      : this.generateCode();

    if (customReferralCode) {
      const collision = await this.prisma.agent.findUnique({
        where: { referralCode },
      });
      if (collision)
        throw new ConflictException(
          'كود الإحالة مستخدم مسبقاً، جرب كوداً آخر.',
        );
    } else {
      let collision = await this.prisma.agent.findUnique({
        where: { referralCode },
      });
      while (collision) {
        referralCode = this.generateCode();
        collision = await this.prisma.agent.findUnique({
          where: { referralCode },
        });
      }
    }

    const agent = await this.prisma.agent.create({
      data: {
        userId,
        referralCode,
        regionId: regionId || null,
        commissionType: commissionType || CommissionType.PERCENTAGE,
        commissionValue: new Prisma.Decimal(
          commissionValue !== undefined ? commissionValue : 10.0,
        ),
        status: AgentStatus.ACTIVE,
      },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, phoneNumber: true },
        },
        region: true,
      },
    });

    // Send push & in-app notification to the assigned delivery representative
    try {
      await this.notificationsService.notifyUser(
        userId,
        'تم تعيينك كمندوب',
        'تم تفعيل حسابك كمندوب توصيل، يمكنك الآن إدارة الطلبات الخاصة بك.',
        {
          notificationType: 'DELIVERY_REPRESENTATIVE_ASSIGNED',
          type: 'DELIVERY_REPRESENTATIVE_ASSIGNED',
          entityType: 'DELIVERY_REPRESENTATIVE',
          entityId: agent.id,
          route: '/delivery-representatives',
        },
      );
    } catch (_) {}

    return agent;
  }

  async findAll() {
    return this.prisma.agent.findMany({
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phoneNumber: true,
          },
        },
        region: true,
        _count: {
          select: {
            referredUsers: true,
            commissions: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phoneNumber: true,
          },
        },
        region: true,
      },
    });
    if (!agent) {
      throw new NotFoundException('المندوب غير موجود.');
    }
    return agent;
  }

  async findByUserId(userId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phoneNumber: true,
          },
        },
        region: true,
      },
    });
    if (!agent) {
      throw new NotFoundException('حساب المندوب الخاص بك غير موجود.');
    }
    return agent;
  }

  async validateCode(code: string) {
    const agent = await this.prisma.agent.findFirst({
      where: {
        referralCode: code.toUpperCase().trim(),
        status: AgentStatus.ACTIVE,
      },
      include: {
        user: {
          select: {
            fullName: true,
          },
        },
      },
    });
    if (!agent) {
      throw new BadRequestException('كود الإحالة المدخل غير صالح أو غير نشط.');
    }
    return agent;
  }

  async update(
    id: string,
    data: {
      regionId?: string;
      commissionType?: CommissionType;
      commissionValue?: number;
      status?: AgentStatus;
    },
  ) {
    const existing = await this.findOne(id);

    const updateData: any = {};
    if (data.regionId !== undefined) updateData.regionId = data.regionId;
    if (data.commissionType !== undefined)
      updateData.commissionType = data.commissionType;
    if (data.commissionValue !== undefined)
      updateData.commissionValue = new Prisma.Decimal(data.commissionValue);
    if (data.status !== undefined) updateData.status = data.status;

    const updated = await this.prisma.agent.update({
      where: { id },
      data: updateData,
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phoneNumber: true,
          },
        },
        region: true,
      },
    });

    // If status changed to ACTIVE, send notification
    if (
      data.status === AgentStatus.ACTIVE &&
      existing.status !== AgentStatus.ACTIVE
    ) {
      try {
        await this.notificationsService.notifyUser(
          existing.userId,
          'تم تعيينك كمندوب',
          'تم تفعيل حسابك كمندوب توصيل، يمكنك الآن إدارة الطلبات الخاصة بك.',
          {
            notificationType: 'DELIVERY_REPRESENTATIVE_ASSIGNED',
            type: 'DELIVERY_REPRESENTATIVE_ASSIGNED',
            entityType: 'DELIVERY_REPRESENTATIVE',
            entityId: updated.id,
            route: '/delivery-representatives',
          },
        );
      } catch (_) {}
    }

    return updated;
  }

  async getDashboardMetrics(agentId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        referredUsers: {
          select: {
            id: true,
            fullName: true,
            phoneNumber: true,
            userType: true,
            isActive: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!agent) throw new NotFoundException('المندوب غير موجود.');

    const commissions = await this.prisma.commission.findMany({
      where: { agentId },
    });

    let totalEarned = new Prisma.Decimal(0);
    let paidAmount = new Prisma.Decimal(0);
    let pendingAmount = new Prisma.Decimal(0);
    let pendingCount = 0;
    let paidCount = 0;

    for (const comm of commissions) {
      totalEarned = totalEarned.add(comm.amount);
      if (comm.status === 'PAID') {
        paidAmount = paidAmount.add(comm.amount);
        paidCount++;
      }
      if (comm.status === 'PENDING') {
        pendingAmount = pendingAmount.add(comm.amount);
        pendingCount++;
      }
    }

    return {
      totalReferrals: agent.referredUsers.length,
      totalEarned,
      paidAmount,
      pendingAmount,
      pendingCount,
      paidCount,
    };
  }

  /** Returns all commissions for the user's agent account (mobile self-service) */
  async getCommissionsForUser(userId: string) {
    const agent = await this.findByUserId(userId);
    return this.prisma.commission.findMany({
      where: { agentId: agent.id },
      include: {
        customer: { select: { fullName: true, phoneNumber: true } },
        subscription: { include: { plan: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Returns all users referred by this agent (mobile self-service) */
  async getReferralsForUser(userId: string) {
    const agent = await this.findByUserId(userId);
    return this.prisma.user.findMany({
      where: { referredByAgentId: agent.id },
      select: {
        id: true,
        fullName: true,
        phoneNumber: true,
        isActive: true,
        userType: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
