import { Controller, Get, Patch, Post, Body, Param, UseGuards, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('api/v1/notifications')
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
    @Body() body: { targetBusinessId: string; title: string; body: string },
  ) {
    // Find the user ID of the target business
    const targetBusiness = await this.prisma.business.findUnique({
      where: { id: body.targetBusinessId },
      select: { userId: true, name: true },
    });

    if (!targetBusiness) {
      throw new Error('المستلم غير موجود');
    }

    return this.notificationsService.sendPushNotification(
      targetBusiness.userId,
      body.title || `رسالة من ${user.fullName}`,
      body.body,
      { type: 'DIRECT_MESSAGE', senderId: user.userId },
    );
  }
}
