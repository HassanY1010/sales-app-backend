import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
    private readonly notificationsService: NotificationsService,
  ) {}

  async getAuditLogs(userId: string, limit = 50) {
    return this.prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async createSuggestion(userId: string, content: string, whatsapp?: string) {
    const suggestion = await this.prisma.suggestion.create({
      data: {
        userId,
        content,
        whatsapp,
      },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phoneNumber: true,
            userType: true,
            business: {
              select: { name: true },
            },
          },
        },
      },
    });

    const senderName = suggestion.user?.fullName || 'مستخدم';
    const preview = content.length > 100 ? `${content.substring(0, 97)}...` : content;
    const notificationTitle = 'شكوى/اقتراح جديد';
    const notificationBody = `من: ${senderName} | ${preview}`;

    // 1. Create persistent notifications in DB for all admins and emit notification:new
    try {
      await this.notificationsService.notifyAdmins(
        notificationTitle,
        notificationBody,
        {
          type: 'suggestion',
          entityType: 'suggestion',
          entityId: suggestion.id,
          suggestionId: suggestion.id,
          route: `/dashboard/suggestions?id=${suggestion.id}`,
          additionalData: {
            senderId: userId,
            senderName,
            userType: suggestion.user?.userType,
            businessName: suggestion.user?.business?.name,
            whatsapp: suggestion.whatsapp,
          },
        },
      );
    } catch (err: any) {
      this.logger.error(`Failed to notify admins for suggestion ${suggestion.id}: ${err.message}`);
    }

    // 2. Realtime socket event for listeners expecting admin-suggestion-created
    this.eventsGateway.server.emit('admin-suggestion-created', suggestion);

    return suggestion;
  }

  async getSubscriptions(businessId: string) {
    return this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        subscriptionStatus: true,
        subscriptionExpiry: true,
      },
    });
  }
}
