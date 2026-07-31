import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Query,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { SendDirectNotificationDto } from './dto/send-direct-notification.dto';
import { SendDebtorAlertsDto } from './dto/send-debtor-alerts.dto';
import { MarkNotificationsReadDto } from './dto/mark-notifications-read.dto';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async getUserNotifications(
    @CurrentUser() user: any,
    @Query() pagination: PaginationDto,
  ) {
    return this.notificationsService.getUserNotifications(
      user.userId,
      pagination,
    );
  }

  @Get('count')
  async getUnreadCount(@CurrentUser() user: any) {
    return this.notificationsService.getUnreadCount(user.userId);
  }

  @Get('unread-count')
  async getUnreadCountAlias(@CurrentUser() user: any) {
    return this.notificationsService.getUnreadCount(user.userId);
  }

  @Patch(':id/read')
  async markAsRead(
    @CurrentUser() user: any,
    @Param('id') notificationId: string,
  ) {
    return this.notificationsService.markAsRead(user.userId, notificationId);
  }

  @Delete(':id')
  async deleteNotification(
    @CurrentUser() user: any,
    @Param('id') notificationId: string,
  ) {
    return this.notificationsService.deleteNotification(
      user.userId,
      notificationId,
    );
  }

  @Post('mark-read')
  async markNotificationsRead(
    @CurrentUser() user: any,
    @Body() dto: MarkNotificationsReadDto,
  ) {
    return this.notificationsService.markManyAsRead(user.userId, dto.ids);
  }

  @Post('send')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async sendDirectNotification(
    @CurrentUser() user: any,
    @Body() body: SendDirectNotificationDto,
  ) {
    let targetUserId = body.targetUserId;
    const isAdmin = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'].includes(user.role);

    if (targetUserId && !isAdmin) {
      throw new BadRequestException(
        'لا يمكن إرسال إشعار مباشر إلا عبر نشاط مرتبط',
      );
    }

    if (body.targetBusinessId) {
      if (!isAdmin && body.targetBusinessId !== user.businessId) {
        const connection = await this.prisma.connection.findFirst({
          where: {
            status: 'ACCEPTED',
            OR: [
              { requesterId: user.businessId, receiverId: body.targetBusinessId },
              { requesterId: body.targetBusinessId, receiverId: user.businessId },
              { id: body.targetBusinessId, OR: [{ requesterId: user.businessId }, { receiverId: user.businessId }] },
            ],
          },
          select: { id: true },
        });

        if (!connection) {
          throw new BadRequestException(
            'لا يمكنك إرسال إشعار إلا لطرف مرتبط بحسابك',
          );
        }
      }

      // Find the user ID of the target business
      const targetBusiness = await this.prisma.business.findUnique({
        where: { id: body.targetBusinessId },
        select: { userId: true },
      });

      if (!targetBusiness) {
        throw new NotFoundException('المستلم (النشاط التجاري) غير موجود');
      }
      targetUserId = targetBusiness.userId;
    }

    if (!targetUserId) {
      throw new BadRequestException(
        'يجب تحديد المستلم (معرف المستخدم أو النشاط التجاري)',
      );
    }

    // Verify target user exists to avoid DB constraint errors
    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });

    if (!targetUser) {
      throw new NotFoundException('المستلم غير موجود في النظام');
    }

    return this.notificationsService.notifyUser(
      targetUserId,
      body.title || `رسالة من ${user.fullName}`,
      body.body,
      { type: 'DIRECT_MESSAGE', senderId: user.userId },
    );
  }

  @Post('debtor-alerts')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async sendDebtorAlerts(
    @CurrentUser() user: any,
    @Body() body: SendDebtorAlertsDto,
  ) {
    if (!user.businessId) {
      throw new BadRequestException('لا يوجد نشاط تجاري مرتبط بهذا المستخدم');
    }

    const connectionIds = [...new Set(body.connectionIds)].filter(Boolean);
    const message = body.body.trim();
    const title = body.title?.trim() || 'تنبيه سداد مديونية';

    if (connectionIds.length === 0) {
      throw new BadRequestException('يجب تحديد عميل واحد على الأقل');
    }

    if (connectionIds.length > 100) {
      throw new BadRequestException(
        'لا يمكن إرسال أكثر من 100 تنبيه في العملية الواحدة',
      );
    }

    if (!message || message.length < 5 || message.length > 1000) {
      throw new BadRequestException(
        'نص التنبيه مطلوب ويجب أن يكون بين 5 و 1000 حرف',
      );
    }

    const connections = await this.prisma.connection.findMany({
      where: {
        id: { in: connectionIds },
        status: 'ACCEPTED',
        OR: [{ requesterId: user.businessId }, { receiverId: user.businessId }],
      },
      include: {
        account: true,
        requester: { select: { id: true, name: true, userId: true } },
        receiver: { select: { id: true, name: true, userId: true } },
      },
    });

    if (connections.length !== connectionIds.length) {
      throw new BadRequestException(
        'توجد اتصالات غير صالحة أو لا تملك صلاحية عليها',
      );
    }

    const sent = [];
    const skipped = [];

    for (const connection of connections) {
      const isRequester = connection.requesterId === user.businessId;
      const dbBalance = Number(connection.account?.balance ?? 0);
      const normalizedBalance = isRequester ? dbBalance : -dbBalance;

      if (normalizedBalance <= 0) {
        skipped.push({
          connectionId: connection.id,
          reason: 'لا يوجد رصيد مدين على هذا العميل',
        });
        continue;
      }

      const targetBusiness = isRequester
        ? connection.receiver
        : connection.requester;

      const notification = await this.notificationsService.notifyUser(
        targetBusiness.userId,
        title,
        message,
        {
          type: 'DEBTOR_ALERT',
          connectionId: connection.id,
          senderBusinessId: user.businessId,
          balance: normalizedBalance.toString(),
        },
      );

      sent.push({
        connectionId: connection.id,
        targetBusinessId: targetBusiness.id,
        targetBusinessName: targetBusiness.name,
        notificationId: notification.id,
      });
    }

    await this.prisma.auditLog.create({
      data: {
        userId: user.userId,
        action: 'SEND_DEBTOR_ALERTS',
        resource: 'NOTIFICATION',
        businessId: user.businessId,
        details: {
          requested: connectionIds.length,
          sentCount: sent.length,
          skippedCount: skipped.length,
          connectionIds,
        },
      },
    });

    return {
      requested: connectionIds.length,
      sentCount: sent.length,
      skippedCount: skipped.length,
      sent,
      skipped,
    };
  }
}
