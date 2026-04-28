import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(private readonly prisma: PrismaService) {}

  async exportData(businessId: string) {
    this.logger.log(`Exporting data for business: ${businessId}`);
    try {
      const [business, users, connections, accounts, orders, transactions, notifications] = await Promise.all([
        this.prisma.business.findUnique({ where: { id: businessId } }),
        this.prisma.user.findMany({ where: { business: { id: businessId } } }),
        this.prisma.connection.findMany({
          where: { OR: [{ requesterId: businessId }, { receiverId: businessId }] },
          include: { account: true }
        }),
        this.prisma.account.findMany({
          where: {
            connection: {
              OR: [{ requesterId: businessId }, { receiverId: businessId }]
            }
          }
        }),
        this.prisma.order.findMany({
          where: { OR: [{ senderId: businessId }, { receiverId: businessId }] },
          include: { items: true }
        }),
        this.prisma.transaction.findMany({
          where: { OR: [{ senderId: businessId }, { receiverId: businessId }] }
        }),
        this.prisma.notification.findMany({
          where: { user: { business: { id: businessId } } }
        })
      ]);

      return {
        exportDate: new Date().toISOString(),
        businessId,
        data: {
          business,
          users,
          connections,
          accounts,
          orders,
          transactions,
          notifications
        }
      };
    } catch (error) {
      this.logger.error(`Export failed: ${error.message}`);
      throw new InternalServerErrorException('فشل تصدير البيانات');
    }
  }

  async restoreData(businessId: string, backupData: any) {
    this.logger.log(`Restoring data for business: ${businessId}`);
    
    if (backupData.businessId !== businessId) {
      throw new InternalServerErrorException('ملف النسخ الاحتياطي لا يخص هذا الحساب');
    }

    // This is a complex operation. For safety, we'll implement it as a transaction
    // and only restore specific user-owned data.
    return this.prisma.$transaction(async (tx) => {
        // Implementation for restoration would go here.
        // For now, we'll return success to allow the UI to be developed.
        return { success: true, message: 'تمت الاستعادة بنجاح (المحاكاة)' };
    });
  }
}
