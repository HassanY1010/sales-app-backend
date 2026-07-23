import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { CommissionsService } from '../commissions/commissions.service';

@Injectable()
export class SubscriptionsService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
    private readonly notificationsService: NotificationsService,
    private readonly commissionsService: CommissionsService,
  ) {}

  onModuleInit() {
    this.checkAndSendExpiryNotifications().catch(() => {});
  }

  async createPaymentRequest(
    userId: string,
    dto: { wallet: string; amount: number; notes?: string },
  ) {
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

    this.logger.log(
      `Payment request created for user ${userId}: ${paymentRequest.id}`,
    );

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
      this.eventsGateway.emitToBusiness(
        request.businessId,
        'subscription-activated',
        {
          expiryDate: oneYearFromNow,
          message: 'تم تفعيل اشتراكك بنجاح!',
        },
      );
    }

    this.logger.log(
      `Payment request ${requestId} approved by admin ${adminId}`,
    );

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

    await this.prisma.$transaction(async (tx) => {
      await tx.paymentRequest.update({
        where: { id: requestId },
        data: {
          status: 'REJECTED',
          approvedById: adminId,
          notes: reason,
        },
      });

      // Update associated commission status to REJECTED if any exists
      await tx.commission.updateMany({
        where: { paymentRequestId: requestId },
        data: {
          status: 'REJECTED',
          notes: `تم رفض وإلغاء العمولة بسبب رفض طلب الدفع من قبل الإدارة. السبب: ${reason || 'غير محدد'}`,
        },
      });
    });

    await this.notificationsService.notifyUser(
      request.userId,
      'تم رفض طلب الدفع',
      'تم رفض طلب الدفع. يرجى التواصل مع الدعم.',
      { type: 'PAYMENT_REJECTED', paymentRequestId: requestId, reason },
    );

    this.logger.log(
      `Payment request ${requestId} rejected by admin ${adminId}`,
    );

    return { success: true, message: 'تم رفض طلب الدفع وتحديث العمولات' };
  }

  /**
   * Automatically check subscriptions expiring in 7, 3, 1 days or expired,
   * sending notifications to affected users without duplicating.
   */
  async checkAndSendExpiryNotifications() {
    try {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];

      const businesses = await this.prisma.business.findMany({
        where: {
          subscriptionExpiry: { not: null },
        },
        include: { user: true },
      });

      for (const b of businesses) {
        if (!b.subscriptionExpiry || !b.userId) continue;

        const expiryTime = b.subscriptionExpiry.getTime();
        const diffMs = expiryTime - now.getTime();
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        let title = '';
        let body = '';
        let notificationType = '';

        if (diffDays === 7) {
          title = 'تنبيه انتهاء الاشتراك';
          body = 'متبقي 7 أيام على انتهاء اشتراكك، يرجى التجديد للاستمرار في استخدام التطبيق.';
          notificationType = 'SUBSCRIPTION_EXPIRING_7_DAYS';
        } else if (diffDays === 3) {
          title = 'تنبيه انتهاء الاشتراك';
          body = 'متبقي 3 أيام على انتهاء اشتراكك، يرجى تجديد الاشتراك.';
          notificationType = 'SUBSCRIPTION_EXPIRING_3_DAYS';
        } else if (diffDays === 1) {
          title = 'تنبيه انتهاء الاشتراك';
          body = 'غداً ينتهي اشتراكك، يرجى التجديد حتى يستمر استخدام التطبيق.';
          notificationType = 'SUBSCRIPTION_EXPIRING_1_DAY';
        } else if (diffDays <= 0 && b.subscriptionStatus !== 'EXPIRED') {
          title = 'انتهى اشتراكك';
          body = 'انتهت مدة اشتراكك في تطبيق حسابك في جيبك. لتجديد الاشتراك يرجى التواصل معنا عبر وسائل التواصل التالية.';
          notificationType = 'SUBSCRIPTION_EXPIRED';

          // Mark status as EXPIRED in DB
          await this.prisma.business.update({
            where: { id: b.id },
            data: { subscriptionStatus: 'EXPIRED' },
          });
        }

        if (notificationType) {
          // Check if notification of this type was already sent today for this user
          const existing = await this.prisma.notification.findFirst({
            where: {
              userId: b.userId,
              type: notificationType,
              createdAt: {
                gte: new Date(`${todayStr}T00:00:00.000Z`),
              },
            },
          });

          if (!existing) {
            await this.notificationsService.notifyUser(
              b.userId,
              title,
              body,
              {
                notificationType,
                type: notificationType,
                entityType: 'SUBSCRIPTION',
                entityId: b.id,
                route: diffDays <= 0 ? '/subscription-expired' : '/settings/subscription',
              },
            );
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`Error in checkAndSendExpiryNotifications: ${err.message}`);
    }
  }

  async checkSubscription(userId: string) {
    // Run background notification check
    this.checkAndSendExpiryNotifications().catch(() => {});

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
    const hasActiveSub =
      user.business?.subscriptionStatus === 'GOLD' &&
      expiryDate &&
      expiryDate > now;

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
      const daysLeft = Math.ceil(
        (trialExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
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

  /**
   * Activate a subscription using a pre-generated activation code.
   * (Blocker-04)
   */
  async activateByCode(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { business: true },
    });

    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    // Only merchants (business users) can activate via code
    if (!user.business) {
      throw new BadRequestException('هذه الخاصية متاحة للتجار فقط');
    }

    // Find and validate the code
    const activationCode = await this.prisma.activationCode.findUnique({
      where: { code },
    });

    if (!activationCode) {
      throw new NotFoundException('رمز التفعيل غير صحيح');
    }

    if (activationCode.isUsed) {
      throw new BadRequestException('تم استخدام هذا الرمز مسبقاً');
    }

    const durationDays = activationCode.durationDays || 365;
    const now = new Date();

    // Extend from current expiry if still active, otherwise from now
    const currentExpiry = user.business.subscriptionExpiry;
    const baseDate = currentExpiry && currentExpiry > now ? currentExpiry : now;

    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + durationDays);

    await this.prisma.$transaction(async (tx) => {
      // Mark code as used
      await tx.activationCode.update({
        where: { code },
        data: {
          isUsed: true,
          usedByUserId: userId,
          usedAt: now,
        },
      });

      // Upgrade business subscription
      await tx.business.update({
        where: { id: user.business!.id },
        data: {
          subscriptionStatus: 'GOLD',
          subscriptionExpiry: newExpiry,
        },
      });

      // Activate user account
      await tx.user.update({
        where: { id: userId },
        data: { isActive: true },
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          userId,
          action: 'ACTIVATE',
          resource: 'SUBSCRIPTION',
          resourceId: activationCode.id,
          details: {
            code,
            durationDays,
            newExpiry: newExpiry.toISOString(),
            businessId: user.business!.id,
          },
        },
      });
    });

    await this.notificationsService.notifyUser(
      userId,
      'تم تفعيل الاشتراك',
      `تم تفعيل اشتراكك بنجاح لمدة ${durationDays} يوم!`,
      { type: 'SUBSCRIPTION_ACTIVATED', expiryDate: newExpiry },
    );

    this.eventsGateway.emitToBusiness(
      user.business.id,
      'subscription-activated',
      {
        expiryDate: newExpiry,
        message: 'تم تفعيل اشتراكك بنجاح!',
      },
    );

    this.logger.log(`Activation code ${code} used by user ${userId}`);

    return {
      success: true,
      message: 'تم تفعيل الاشتراك بنجاح',
      expiryDate: newExpiry.toISOString(),
      durationDays,
    };
  }

  async getPlans() {
    return this.prisma.subscriptionPlan.findMany({
      orderBy: { price: 'asc' },
    });
  }

  async getPlanById(id: string) {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id },
    });
    if (!plan) throw new NotFoundException('خطة الاشتراك غير موجودة');
    return plan;
  }

  async createPlan(dto: any) {
    return this.prisma.subscriptionPlan.create({
      data: {
        name: dto.name,
        description: dto.description,
        price: dto.price,
        durationDays: dto.durationDays ?? 365,
        features: dto.features ?? {},
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updatePlan(id: string, dto: any) {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id },
    });
    if (!plan) throw new NotFoundException('خطة الاشتراك غير موجودة');

    return this.prisma.subscriptionPlan.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.price !== undefined && { price: dto.price }),
        ...(dto.durationDays !== undefined && {
          durationDays: dto.durationDays,
        }),
        ...(dto.features !== undefined && { features: dto.features }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async deletePlan(id: string) {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id },
    });
    if (!plan) throw new NotFoundException('خطة الاشتراك غير موجودة');

    await this.prisma.subscriptionPlan.delete({ where: { id } });
    return { success: true, message: 'تم حذف خطة الاشتراك بنجاح' };
  }

  // =========================================================================
  // ADMIN SUBSCRIPTION MANAGEMENT MODULE
  // =========================================================================

  async getAdminSubscriptionsList(params: {
    page?: number;
    limit?: number;
    search?: string;
    filter?: string;
  }) {
    const page = Number(params.page || 1);
    const limit = Number(params.limit || 20);
    const skip = (page - 1) * limit;
    const now = new Date();

    const searchStr = params.search?.trim();

    const where: any = {};

    if (searchStr) {
      where.OR = [
        { name: { contains: searchStr, mode: 'insensitive' } },
        { phoneNumber: { contains: searchStr } },
        { email: { contains: searchStr, mode: 'insensitive' } },
        { user: { fullName: { contains: searchStr, mode: 'insensitive' } } },
        { user: { phoneNumber: { contains: searchStr } } },
      ];
    }

    if (params.filter === 'ACTIVE') {
      where.subscriptionStatus = 'GOLD';
      where.subscriptionExpiry = { gt: now };
    } else if (params.filter === 'EXPIRED') {
      where.OR = [
        { subscriptionStatus: 'EXPIRED' },
        { subscriptionExpiry: { lte: now } },
      ];
    } else if (params.filter === 'EXPIRING_7') {
      const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      where.subscriptionExpiry = { gte: now, lte: in7Days };
    } else if (params.filter === 'EXPIRING_30') {
      const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      where.subscriptionExpiry = { gte: now, lte: in30Days };
    } else if (params.filter === 'SUSPENDED') {
      where.subscriptionStatus = 'SUSPENDED';
    }

    const [businesses, total] = await Promise.all([
      this.prisma.business.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phoneNumber: true,
              createdAt: true,
            },
          },
        },
      }),
      this.prisma.business.count({ where }),
    ]);

    // Top Summary Statistics
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalSubscribers, activeSubscriptions, expiredSubscriptions, expiringSoon, newThisMonth] =
      await Promise.all([
        this.prisma.business.count(),
        this.prisma.business.count({
          where: {
            subscriptionStatus: 'GOLD',
            subscriptionExpiry: { gt: now },
          },
        }),
        this.prisma.business.count({
          where: {
            OR: [
              { subscriptionStatus: 'EXPIRED' },
              { subscriptionExpiry: { lte: now } },
            ],
          },
        }),
        this.prisma.business.count({
          where: {
            subscriptionExpiry: {
              gte: now,
              lte: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
            },
          },
        }),
        this.prisma.business.count({
          where: {
            createdAt: { gte: startOfMonth },
          },
        }),
      ]);

    const formattedData = businesses.map((b) => {
      const expiry = b.subscriptionExpiry;
      let calculatedStatus = 'ACTIVE';
      let remainingDays = 0;

      if (b.subscriptionStatus === 'SUSPENDED') {
        calculatedStatus = 'SUSPENDED';
      } else if (!expiry || expiry <= now) {
        calculatedStatus = 'EXPIRED';
        remainingDays = 0;
      } else {
        const diffMs = expiry.getTime() - now.getTime();
        remainingDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        if (remainingDays <= 7) {
          calculatedStatus = 'EXPIRING_SOON';
        } else {
          calculatedStatus = 'ACTIVE';
        }
      }

      return {
        id: b.id,
        businessId: b.id,
        userId: b.userId,
        companyName: b.name,
        userName: b.user.fullName,
        phoneNumber: b.phoneNumber || b.user.phoneNumber,
        email: b.email || b.user.email,
        startDate: b.createdAt.toISOString(),
        expirationDate: expiry ? expiry.toISOString() : null,
        remainingDays,
        status: calculatedStatus,
        rawStatus: b.subscriptionStatus,
      };
    });

    return {
      data: formattedData,
      summary: {
        totalSubscribers,
        activeSubscriptions,
        expiredSubscriptions,
        expiringSoon,
        newThisMonth,
      },
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async renewSubscriptionAdmin(
    adminId: string,
    dto: {
      businessId: string;
      durationType: 'MONTHLY' | '3_MONTHS' | '6_MONTHS' | 'YEARLY' | 'CUSTOM';
      customDays?: number;
      notes?: string;
    },
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: dto.businessId },
      include: { user: true },
    });
    if (!business) throw new NotFoundException('الشركة / المستخدم غير موجود');

    let days = 365;
    if (dto.durationType === 'MONTHLY') days = 30;
    else if (dto.durationType === '3_MONTHS') days = 90;
    else if (dto.durationType === '6_MONTHS') days = 180;
    else if (dto.durationType === 'YEARLY') days = 365;
    else if (dto.durationType === 'CUSTOM') days = dto.customDays || 30;

    const now = new Date();
    const baseDate =
      business.subscriptionExpiry && business.subscriptionExpiry > now
        ? business.subscriptionExpiry
        : now;

    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + days);

    const updated = await this.prisma.business.update({
      where: { id: dto.businessId },
      data: {
        subscriptionStatus: 'GOLD',
        subscriptionExpiry: newExpiry,
      },
    });

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'RENEW_SUBSCRIPTION',
        resource: 'SUBSCRIPTION',
        resourceId: dto.businessId,
        details: {
          durationType: dto.durationType,
          daysAdded: days,
          oldExpiry: business.subscriptionExpiry
            ? business.subscriptionExpiry.toISOString()
            : null,
          newExpiry: newExpiry.toISOString(),
          notes: dto.notes,
        },
      },
    });

    // Format new expiration date string (e.g. DD/MM/YYYY)
    const formattedDateStr = newExpiry.toISOString().split('T')[0];

    // Notify user
    try {
      await this.notificationsService.notifyUser(
        business.userId,
        'تم تجديد اشتراكك',
        `تم تجديد اشتراكك بنجاح حتى ${formattedDateStr}.`,
        {
          notificationType: 'SUBSCRIPTION_RENEWED',
          type: 'SUBSCRIPTION_RENEWED',
          entityType: 'SUBSCRIPTION',
          entityId: dto.businessId,
          route: '/settings/subscription',
        },
      );
    } catch (_) {}

    return {
      success: true,
      message: 'تم تجديد الاشتراك بنجاح',
      newExpiry: newExpiry.toISOString(),
      business: updated,
    };
  }

  async modifySubscriptionDurationAdmin(
    adminId: string,
    dto: {
      businessId: string;
      endDate?: string;
      days?: number;
    },
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: dto.businessId },
    });
    if (!business) throw new NotFoundException('العمل غير موجود');

    let newExpiry: Date;
    if (dto.endDate) {
      newExpiry = new Date(dto.endDate);
    } else if (dto.days) {
      newExpiry = new Date();
      newExpiry.setDate(newExpiry.getDate() + dto.days);
    } else {
      throw new BadRequestException('يرجى تحديد تـاريخ الانتهاء أو عدد الأيام');
    }

    const updated = await this.prisma.business.update({
      where: { id: dto.businessId },
      data: {
        subscriptionExpiry: newExpiry,
        subscriptionStatus: newExpiry > new Date() ? 'GOLD' : 'EXPIRED',
      },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'MODIFY_SUBSCRIPTION_DURATION',
        resource: 'SUBSCRIPTION',
        resourceId: dto.businessId,
        details: {
          newExpiry: newExpiry.toISOString(),
        },
      },
    });

    return { success: true, message: 'تم تعديل مدة الاشتراك بنجاح', updated };
  }

  async suspendSubscriptionAdmin(
    adminId: string,
    businessId: string,
    reason?: string,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business) throw new NotFoundException('العمل غير موجود');

    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: { subscriptionStatus: 'SUSPENDED' },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'SUSPEND_SUBSCRIPTION',
        resource: 'SUBSCRIPTION',
        resourceId: businessId,
        details: { reason },
      },
    });

    try {
      await this.notificationsService.notifyUser(
        business.userId,
        'تم إيقاف الاشتراك',
        'تم إيقاف اشتراكك مؤقتاً من قبل الإدارة. يرجى التواصل مع الدعم.',
        {
          notificationType: 'SUBSCRIPTION_SUSPENDED',
          type: 'SUBSCRIPTION_SUSPENDED',
          entityType: 'SUBSCRIPTION',
          entityId: businessId,
          route: '/subscription-expired',
        },
      );
    } catch (_) {}

    return { success: true, message: 'تم إيقاف الاشتراك بنجاح', updated };
  }

  async activateSubscriptionAdmin(adminId: string, businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business) throw new NotFoundException('العمل غير موجود');

    const now = new Date();
    let expiry = business.subscriptionExpiry;
    if (!expiry || expiry <= now) {
      expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    }

    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: {
        subscriptionStatus: 'GOLD',
        subscriptionExpiry: expiry,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'ACTIVATE_SUBSCRIPTION',
        resource: 'SUBSCRIPTION',
        resourceId: businessId,
        details: { expiry: expiry.toISOString() },
      },
    });

    try {
      await this.notificationsService.notifyUser(
        business.userId,
        'تم تفعيل الاشتراك',
        'تم إعادة تفعيل اشتراكك بنجاح.',
        {
          notificationType: 'SUBSCRIPTION_ACTIVATED',
          type: 'SUBSCRIPTION_ACTIVATED',
          entityType: 'SUBSCRIPTION',
          entityId: businessId,
          route: '/settings/subscription',
        },
      );
    } catch (_) {}

    return { success: true, message: 'تم إعادة تفعيل الاشتراك بنجاح', updated };
  }

  async sendSubscriptionNotificationAdmin(
    adminId: string,
    dto: { userId: string; title: string; message: string },
  ) {
    await this.notificationsService.notifyUser(
      dto.userId,
      dto.title,
      dto.message,
      {
        notificationType: 'CUSTOM_ADMIN_MESSAGE',
        type: 'CUSTOM_ADMIN_MESSAGE',
        entityType: 'SUBSCRIPTION',
        route: '/settings/subscription',
      },
    );

    await this.prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'SEND_SUBSCRIPTION_NOTIFICATION',
        resource: 'SUBSCRIPTION',
        resourceId: dto.userId,
        details: { title: dto.title, message: dto.message },
      },
    });

    return { success: true, message: 'تم إرسال الإشعار للمستخدم بنجاح' };
  }

  async getSubscriptionHistoryAdmin(businessId: string) {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { resourceId: businessId },
          { resource: 'SUBSCRIPTION' },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        user: { select: { id: true, fullName: true, email: true } },
      },
    });

    return logs.map((log) => ({
      id: log.id,
      actionType: log.action,
      createdAt: log.createdAt,
      adminName: log.user?.fullName || 'النظام / الأدمن',
      details: log.details,
    }));
  }
}

