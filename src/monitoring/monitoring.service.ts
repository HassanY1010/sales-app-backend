import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAuditLogs(userId: string, limit = 50) {
    return this.prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async createSuggestion(userId: string, content: string, whatsapp?: string) {
    return this.prisma.suggestion.create({
      data: {
        userId,
        content,
        whatsapp,
      },
    });
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

  async activateSubscription(businessId: string, code: string) {
    // Simple verification logic for demo purposes
    // In production, this would call a payment gateway or a secure license server
    if (code === 'GOLD-2026-NEQAWA' || code === 'TEST-ACTIVATE') {
      const expiry = new Date();
      expiry.setFullYear(expiry.getFullYear() + 1); // 1 year
      return this.prisma.business.update({
        where: { id: businessId },
        data: {
          subscriptionStatus: 'GOLD',
          subscriptionExpiry: expiry,
        },
      });
    }
    throw new Error('رمز التفعيل غير صحيح');
  }
}
