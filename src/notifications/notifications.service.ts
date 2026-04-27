import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class NotificationsService {
  private logger = new Logger('NotificationsService');
  private isFirebaseInitialized = false;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    this.initializeFirebase();
  }

  private initializeFirebase() {
    const projectId = this.configService.get<string>('FCM_PROJECT_ID');
    const privateKey = this.configService.get<string>('FCM_PRIVATE_KEY')?.replace(/\\n/g, '\n');
    const clientEmail = this.configService.get<string>('FCM_CLIENT_EMAIL');

    if (projectId && privateKey && clientEmail) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          privateKey,
          clientEmail,
        }),
      });
      this.isFirebaseInitialized = true;
      this.logger.log('Firebase Admin Initialized Successfully');
    } else {
      this.logger.warn('Firebase Admin credentials not fully provided format. Push notifications will be skipped.');
    }
  }

  async sendPushNotification(
    userId: string,
    title: string,
    body: string,
    data?: any,
  ) {
    // 1. Save to database
    await this.prisma.notification.create({
      data: {
        userId,
        title,
        body,
        type: data?.type,
      },
    });

    if (!this.isFirebaseInitialized) return;

    // 2. Fetch User pushToken
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { pushToken: true },
    });

    if (user?.pushToken) {
      try {
        await admin.messaging().send({
          token: user.pushToken,
          notification: {
            title,
            body,
          },
          data: data || {},
        });
      } catch (error) {
        this.logger.error(`Failed to send push notification: ${error.message}`);
      }
    }
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
}
