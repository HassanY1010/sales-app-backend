import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { EventsGateway } from '../events/events.gateway';

type NotificationPayload = {
  type?: string;
  [key: string]: any;
};

@Injectable()
export class NotificationsService {
  private logger = new Logger('NotificationsService');
  private isFirebaseInitialized = false;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private eventsGateway: EventsGateway,
  ) {
    this.initializeFirebase();
  }

  private initializeFirebase() {
    const projectId = this.configService.get<string>('FCM_PROJECT_ID');
    const privateKey = this.configService
      .get<string>('FCM_PRIVATE_KEY')
      ?.replace(/\\n/g, '\n');
    const clientEmail = this.configService.get<string>('FCM_CLIENT_EMAIL');

    if (
      admin.apps.length === 0 &&
      projectId &&
      privateKey &&
      privateKey.includes('BEGIN PRIVATE KEY') &&
      clientEmail
    ) {
      try {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            privateKey,
            clientEmail,
          }),
        });
        this.isFirebaseInitialized = true;
        this.logger.log('Firebase Admin Initialized Successfully');
      } catch (err: any) {
        this.isFirebaseInitialized = false;
        this.logger.warn(
          `Firebase Admin initialization failed (FCM push notifications disabled): ${err.message}`,
        );
      }
    } else {
      this.isFirebaseInitialized = admin.apps.length > 0;
      if (!this.isFirebaseInitialized) {
        this.logger.warn(
          'Firebase Admin credentials not configured. Database and socket notifications remain active.',
        );
      }
    }
  }

  private toFcmData(data?: NotificationPayload): Record<string, string> {
    if (!data) return {};
    return Object.entries(data).reduce<Record<string, string>>(
      (acc, [key, value]) => {
        if (value === undefined || value === null) return acc;
        acc[key] = typeof value === 'string' ? value : JSON.stringify(value);
        return acc;
      },
      {},
    );
  }

  private async sendFcm(
    userId: string,
    title: string,
    body: string,
    data?: NotificationPayload,
  ) {
    if (!this.isFirebaseInitialized) return;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { pushToken: true },
    });

    if (!user?.pushToken) return;

    // Calculate current unread count for the user
    const unreadCount = await this.prisma.notification.count({
      where: { userId, isRead: false },
    });

    try {
      await admin.messaging().send({
        token: user.pushToken,
        notification: { title, body },
        data: {
          ...this.toFcmData(data),
          badge: unreadCount.toString(),
        },
        android: {
          notification: {
            notificationCount: unreadCount,
          },
        },
        apns: {
          payload: {
            aps: {
              badge: unreadCount,
            },
          },
        },
      });
    } catch (error: any) {
      this.logger.error(`Failed to send push notification: ${error.message}`);
    }
  }

  async sendPushNotification(
    userId: string,
    title: string,
    body: string,
    data?: NotificationPayload,
  ) {
    return this.notifyUser(userId, title, body, data);
  }

  private ensureMandatoryMetadata(data?: NotificationPayload): NotificationPayload {
    const payload = { ...(data || {}) };

    // 1. Resolve entityId from common keys
    if (!payload.entityId) {
      const rawId = payload.recordId || payload.orderId || payload.connectionId || payload.transactionId || payload.paymentRequestId || payload.commissionId || payload.requestId;
      if (rawId) {
        payload.entityId = String(rawId);
      }
    }

    // 2. Resolve notificationType and entityType
    if (!payload.notificationType && payload.type) {
      payload.notificationType = payload.type;
    }
    if (!payload.entityType) {
      const typeLower = String(payload.type || '').toLowerCase();
      if (typeLower.includes('invoice') || typeLower.includes('order')) {
        payload.entityType = 'invoice';
      } else if (typeLower.includes('receipt') || typeLower.includes('payment') || typeLower.includes('voucher')) {
        payload.entityType = 'receipt_voucher';
      } else if (typeLower.includes('link') || typeLower.includes('connection')) {
        payload.entityType = 'link_request';
      } else if (typeLower.includes('sync')) {
        payload.entityType = 'sync';
      } else if (typeLower.includes('representative') || typeLower.includes('delivery') || typeLower.includes('agent')) {
        payload.entityType = 'DELIVERY_REPRESENTATIVE';
      } else if (typeLower.includes('subscription')) {
        payload.entityType = 'subscription';
      } else if (typeLower.includes('password')) {
        payload.entityType = 'USER';
        payload.route = '/change-password';
      } else {
        payload.entityType = payload.type || 'system';
      }
    }

    // 3. Resolve route if missing
    if (!payload.route && payload.entityType) {
      const entId = payload.entityId || '';
      switch (payload.entityType) {
        case 'DELIVERY_REPRESENTATIVE':
        case 'delivery_representative':
        case 'agent':
          payload.route = '/delivery-representatives';
          break;
        case 'USER':
        case 'user':
        case 'password':
          payload.route = '/change-password';
          break;
        case 'invoice':
          payload.route = `/orders/${entId}`;
          break;
        case 'receipt_voucher':
          payload.route = `/receipt-vouchers/${entId}`;
          break;
        case 'link_request':
          payload.route = entId ? `/connection-request/${entId}` : `/connection-requests`;
          break;
        case 'customer':
          payload.route = `/customers/${entId}`;
          break;
        case 'supplier':
          payload.route = `/suppliers/${entId}`;
          break;
        case 'sync':
          payload.route = `/settings/backup`;
          break;
        case 'subscription':
          payload.route = payload.type === 'SUBSCRIPTION_EXPIRED' ? '/subscription-expired' : '/settings/subscription';
          break;
        default:
          payload.route = `/notifications`;
      }
    }

    // 4. Ensure additionalData is present
    if (!payload.additionalData) {
      payload.additionalData = {};
    }

    return payload;
  }

  async notifyUser(
    userId: string,
    title: string,
    body: string,
    data?: NotificationPayload,
  ) {
    const resolvedData = this.ensureMandatoryMetadata(data);
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        title,
        body,
        type: resolvedData.notificationType,
        metadata: resolvedData ? (resolvedData as any) : undefined,
      },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { business: { select: { id: true } } },
    });

    const payload = {
      ...notification,
      data: resolvedData,
    };

    this.eventsGateway.emitToUserBusiness(user?.business?.id, payload);
    await this.sendFcm(userId, title, body, resolvedData);

    return notification;
  }

  async notifyBusiness(
    businessId: string,
    title: string,
    body: string,
    data?: NotificationPayload,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { userId: true },
    });

    if (!business) return null;
    return this.notifyUser(business.userId, title, body, data);
  }

  async notifyAdmins(title: string, body: string, data?: NotificationPayload) {
    const admins = await this.prisma.user.findMany({
      where: {
        role: { in: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'] },
        isActive: true,
      },
      select: { id: true },
    });

    const notifications = await Promise.all(
      admins.map((adminUser) =>
        this.notifyUser(adminUser.id, title, body, data),
      ),
    );

    this.eventsGateway.emitToAllAdmins('notification:new', {
      title,
      body,
      data: data ?? {},
      createdAt: new Date().toISOString(),
    });

    return notifications;
  }

  async getUserNotifications(userId: string, pagination: PaginationDto) {
    const { page = 1, limit = 20 } = pagination;
    const where = { userId };

    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
        limit,
      },
    };
  }

  async markAsRead(userId: string, notificationId: string) {
    return this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true },
    });
  }

  async markManyAsRead(userId: string, notificationIds?: string[]) {
    return this.prisma.notification.updateMany({
      where: {
        userId,
        ...(notificationIds?.length ? { id: { in: notificationIds } } : {}),
      },
      data: { isRead: true },
    });
  }

  async getUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, isRead: false },
    });

    return { count };
  }

  async deleteNotification(userId: string, notificationId: string) {
    await this.prisma.notification.deleteMany({
      where: { id: notificationId, userId },
    });
    const count = await this.prisma.notification.count({
      where: { userId, isRead: false },
    });

    return { success: true, id: notificationId, count };
  }
}
