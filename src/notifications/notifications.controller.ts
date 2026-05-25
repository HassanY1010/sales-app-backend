import { Controller, Get, Patch, Post, Body, Param, UseGuards, Query, NotFoundException, BadRequestException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';

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
    return this.notificationsService.getUserNotifications(user.userId, pagination);
  }

  @Patch(':id/read')
  async markAsRead(@CurrentUser() user: any, @Param('id') notificationId: string) {
    return this.notificationsService.markAsRead(user.userId, notificationId);
  }

  @Post('send')
  async sendDirectNotification(
    @CurrentUser() user: any,
    @Body() body: { targetBusinessId?: string; targetUserId?: string; title?: string; body: string },
  ) {
    let targetUserId = body.targetUserId;
    const isAdmin = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'].includes(user.role);

    if (targetUserId && !isAdmin) {
      throw new BadRequestException('لا يمكن إرسال إشعار مباشر إلا عبر نشاط مرتبط');
    }

    if (body.targetBusinessId) {
      if (!isAdmin && body.targetBusinessId !== user.businessId) {
        const connection = await this.prisma.connection.findFirst({
          where: {
            status: 'ACCEPTED',
            OR: [
              { requesterId: user.businessId, receiverId: body.targetBusinessId },
              { requesterId: body.targetBusinessId, receiverId: user.businessId },
            ],
          },
          select: { id: true },
        });

        if (!connection) {
          throw new BadRequestException('لا يمكنك إرسال إشعار إلا لطرف مرتبط بحسابك');
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
      throw new BadRequestException('يجب تحديد المستلم (معرف المستخدم أو النشاط التجاري)');
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
}
