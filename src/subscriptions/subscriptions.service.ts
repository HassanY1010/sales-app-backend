import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { CommissionsService } from '../commissions/commissions.service';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
    private readonly notificationsService: NotificationsService,
    private readonly commissionsService: CommissionsService,
  ) {}

  async createPaymentRequest(userId: string, dto: { wallet: string; amount: number; notes?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { business: true },
    });

    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    const paymentRequest = await this.prisma.paymentRequest.create({
      data: {
        userId,
        businessId: user.business?.id,
        amount: dto.amount,
        wallet: dto.wallet,
        notes: dto.notes,
        status: 'PENDING',
      },
      include: {
        user: { select: { id: true, fullName: true, phoneNumber: true } },
        business: true,
      },
    });

    await this.notificationsService.notifyUser(
      userId,
      'طلب تفعيل جديد',
      `تم استلام طلب دفع بمبلغ ${dto.amount} عبر ${dto.wallet}`,
      { type: 'PAYMENT_REQUEST', paymentRequestId: paymentRequest.id },
    );

    await this.notificationsService.notifyAdmins(
      'طلب تفعيل جديد',
      `طلب دفع جديد من ${user.fullName} بمبلغ ${dto.amount}`,
      { type: 'ADMIN_PAYMENT_REQUEST', paymentRequestId: paymentRequest.id },
    );

    // Emit real-time notification to admin dashboard via WebSocket
    this.eventsGateway.emitToAllAdmins('admin-payment-request', {
      id: paymentRequest.id,
      user: paymentRequest.user,
      business: paymentRequest.business,
      amount: paymentRequest.amount,
      wallet: paymentRequest.wallet,
      createdAt: paymentRequest.createdAt,
    });

    this.logger.log(`Payment request created for user ${userId}: ${paymentRequest.id}`);

    return paymentRequest;
  }

  async getPendingRequests(page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [requests, total] = await Promise.all([
      this.prisma.paymentRequest.findMany({
        where: { status: 'PENDING' },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, fullName: true, phoneNumber: true } },
          business: true,
        },
      }),
      this.prisma.paymentRequest.count({ where: { status: 'PENDING' } }),
    ]);

    return {
      data: requests,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async approvePayment(requestId: string, adminId: string, notes?: string) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { id: requestId },
      include: { user: true, business: true },
    });

    if (!request) {
      throw new NotFoundException('طلب الدفع غير موجود');
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException('هذا الطلب تم معالجته مسبقاً');
    }

    const oneYearFromNow = new Date();
    oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);

    await this.prisma.$transaction(async (tx) => {
      await tx.paymentRequest.update({
        where: { id: requestId },
        data: {
          status: 'APPROVED',
          approvedById: adminId,
          notes: notes || request.notes,
        },
      });

      if (request.businessId) {
        await tx.business.update({
          where: { id: request.businessId },
          data: {
            subscriptionStatus: 'GOLD',
            subscriptionExpiry: oneYearFromNow,
          },
        });
      }

      await tx.user.update({
        where: { id: request.userId },
        data: { isActive: true },
      });

      await tx.auditLog.create({
        data: {
          userId: adminId,
          action: 'APPROVE_PAYMENT',
          resource: 'PAYMENT_REQUEST',
          resourceId: requestId,
          details: {
            amount: request.amount.toString(),
            wallet: request.wallet,
          },
        },
      });

      // ===== Commission Engine Integration =====
      // Runs inside the same transaction — atomic & safe.
      // Silently skips if user was not referred by an agent.
      await this.commissionsService.processSubscriptionCommission(
        tx,
        requestId,
        request.businessId ?? requestId, // fallback if no businessId
        request.userId,
        Number(request.amount),
      );
    });

    await this.notificationsService.notifyUser(
      request.userId,
      'تم تفعيل الاشتراك',
      'تم تفعيل اشتراكك بنجاح! اشتراكك صالح لمدة سنة.',
      { type: 'SUBSCRIPTION_ACTIVATED', paymentRequestId: requestId },
    );

    // Emit real-time update to user if connected
    if (request.businessId) {
      this.eventsGateway.emitToBusiness(request.businessId, 'subscription-activated', {
        expiryDate: oneYearFromNow,
        message: 'تم تفعيل اشتراكك بنجاح!',
      });
    }

    this.logger.log(`Payment request ${requestId} approved by admin ${adminId}`);

    return { success: true, message: 'تم تفعيل الاشتراك بنجاح' };
  }

  async rejectPayment(requestId: string, adminId: string, reason?: string) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException('طلب الدفع غير موجود');
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException('هذا الطلب تم معالجته مسبقاً');
    }

    await this.prisma.paymentRequest.update({
      where: { id: requestId },
      data: {
        status: 'REJECTED',
        approvedById: adminId,
        notes: reason,
      },
    });

    await this.notificationsService.notifyUser(
      request.userId,
      'تم رفض طلب الدفع',
      'تم رفض طلب الدفع. يرجى التواصل مع الدعم.',
      { type: 'PAYMENT_REJECTED', paymentRequestId: requestId, reason },
    );

    this.logger.log(`Payment request ${requestId} rejected by admin ${adminId}`);

    return { success: true, message: 'تم رفض طلب الدفع' };
  }

  async checkSubscription(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { business: true },
    });

    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    // 1) Consumers (individual) are 100% free
    if (user.userType === 'individual') {
      return {
        status: 'active',
        isFree: true,
        expiryDate: null,
        forceLogout: !user.isActive,
      };
    }

    const now = new Date();
    const expiryDate = user.business?.subscriptionExpiry;
    
    // 2) Check if user has an active PAID subscription
    const hasActiveSub = user.business?.subscriptionStatus === 'GOLD' && expiryDate && expiryDate > now;
    
    if (hasActiveSub) {
      return {
        status: 'active',
        isTrial: false,
        expiryDate: expiryDate.toISOString(),
        forceLogout: !user.isActive,
      };
    }

    // 3) Check for 90-day Trial (3 months)
    const registrationDate = user.createdAt;
    const trialExpiry = new Date(registrationDate);
    trialExpiry.setDate(trialExpiry.getDate() + 90);

    if (now < trialExpiry) {
      const daysLeft = Math.ceil((trialExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return {
        status: 'trial',
        isTrial: true,
        expiryDate: trialExpiry.toISOString(),
        daysLeft,
        forceLogout: !user.isActive,
      };
    }

    // 4) Otherwise, expired
    return {
      status: 'expired',
      isTrial: false,
      expiryDate: trialExpiry.toISOString(),
      forceLogout: !user.isActive,
    };
  }

  async extendSubscription(businessId: string, adminId: string, days?: number) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      throw new NotFoundException('العمل غير موجود');
    }

    // Default to 365 days if days is not provided
    const daysToAdd = days || 365;

    // Use current date if expiry is missing or in the past, otherwise use existing expiry
    const now = new Date();
    const currentExpiry = business.subscriptionExpiry;
    let baseDate = now;
    
    if (currentExpiry && currentExpiry > now) {
      baseDate = currentExpiry;
    } else if (!currentExpiry && business.createdAt) {
      // If no expiry exists, check if trial is still active
      const trialExpiry = new Date(business.createdAt);
      trialExpiry.setDate(trialExpiry.getDate() + 90);
      if (trialExpiry > now) {
        baseDate = trialExpiry;
      }
    }

    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + daysToAdd);

    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: {
        subscriptionStatus: 'GOLD',
        subscriptionExpiry: newExpiry,
      },
    });

    await this.notificationsService.notifyUser(
      business.userId,
      'تم تمديد الاشتراك',
      'تم تمديد اشتراكك لمدة سنة إضافية.',
      { type: 'SUBSCRIPTION_EXTENDED', businessId, expiryDate: newExpiry },
    );

    this.eventsGateway.emitToBusiness(businessId, 'subscription-extended', {
      expiryDate: newExpiry,
      message: 'تم تمديد اشتراكك بنجاح!',
    });

    return updated;
  }

  async getSubscriptionStats() {
    const [
      activeSubscriptions,
      expiredSubscriptions,
      pendingRequests,
      totalUsers,
    ] = await Promise.all([
      this.prisma.business.count({
        where: {
          subscriptionStatus: 'GOLD',
          subscriptionExpiry: { gt: new Date() },
        },
      }),
      this.prisma.business.count({
        where: {
          OR: [
            { subscriptionStatus: 'EXPIRED' },
            { subscriptionExpiry: { lt: new Date() } },
          ],
        },
      }),
      this.prisma.paymentRequest.count({ where: { status: 'PENDING' } }),
      this.prisma.user.count(),
    ]);

    return {
      activeSubscriptions,
      expiredSubscriptions,
      pendingRequests,
      totalUsers,
    };
  }
}
