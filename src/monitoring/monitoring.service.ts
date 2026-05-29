import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
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
            fullName: true,
            userType: true,
          },
        },
      },
    });

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
