import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

type AuditInput = {
  userId?: string | null;
  businessId?: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  details?: Record<string, any>;
  ipAddress?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly sensitiveKeys = new Set([
    'password',
    'newPassword',
    'oldPassword',
    'confirmPassword',
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'securityPin',
  ]);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: input.userId || undefined,
          businessId: input.businessId || undefined,
          action: input.action,
          resource: input.resource,
          resourceId: input.resourceId || undefined,
          details: this.sanitize(input.details || {}),
          ipAddress: input.ipAddress || undefined,
          method: input.method || undefined,
          path: input.path || undefined,
          statusCode: input.statusCode || undefined,
        },
      });
    } catch (error) {
      this.logger.warn(`Audit log write failed: ${error.message}`);
    }
  }

  sanitize(value: any): any {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitize(item));
    }

    if (value && typeof value === 'object') {
      return Object.entries(value).reduce<Record<string, any>>((acc, [key, item]) => {
        acc[key] = this.sensitiveKeys.has(key) ? '[REDACTED]' : this.sanitize(item);
        return acc;
      }, {});
    }

    return value;
  }
}
