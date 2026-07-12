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

    try {
      await admin.messaging().send({
        token: user.pushToken,
        notification: { title, body },
        data: this.toFcmData(data),
      });
    } catch (error) {
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

  async notifyUser(
    userId: string,
    title: string,
    body: string,
    data?: NotificationPayload,
  ) {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        title,
        body,
        type: data?.type,
        metadata: data ? (data as any) : undefined,
      },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { business: { select: { id: true } } },
    });

    const payload = {
      ...notification,
      data: data ?? {},
    };

    this.eventsGateway.emitToUserBusiness(user?.business?.id, payload);
    await this.sendFcm(userId, title, body, data);

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
}
