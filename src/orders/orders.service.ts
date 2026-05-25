import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../database/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderPricesDto, UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { FinanceService } from '../finance/finance.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly financeService: FinanceService,
    private readonly notificationsService: NotificationsService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  async createOrder(senderId: string, dto: CreateOrderDto, userType: string) {
    if (senderId === dto.receiverId) {
      throw new BadRequestException('لا يمكنك إنشاء طلبية لنفسك');
    }

    const connection = await this.prisma.connection.findFirst({
      where: {
        OR: [
          { requesterId: senderId, receiverId: dto.receiverId },
          { requesterId: dto.receiverId, receiverId: senderId },
        ],
        status: 'ACCEPTED',
      },
      include: { account: true },
    });

    if (!connection?.account) {
      throw new BadRequestException('يجب وجود ارتباط مقبول وحساب مالي لإنشاء طلبية');
    }

    const [senderBusiness, receiverBusiness] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: senderId }, include: { user: true } }),
      this.prisma.business.findUnique({ where: { id: dto.receiverId }, include: { user: true } }),
    ]);

    if (!senderBusiness || !receiverBusiness) {
      throw new BadRequestException('الطرف المرسل أو المستقبل غير صالح');
    }

    if (userType === 'individual' && receiverBusiness.user.userType !== 'business') {
      throw new ForbiddenException('المستهلك يمكنه إرسال طلبيات شراء لحسابات تجارية فقط');
    }

    const pricesVisible = connection.showPrices || userType === 'business';
    let subtotal = new Decimal(0);
    const itemsData = dto.items.map((item) => {
      const unitPrice = pricesVisible ? new Decimal(item.unitPrice || '0') : new Decimal(0);
      const total = unitPrice.mul(item.quantity);
      subtotal = subtotal.plus(total);
      return {
        ...item,
        unitPrice: unitPrice.toString(),
        total: total.toString(),
      };
    });

    const taxAmount = new Decimal(dto.tax || '0');
    const discountAmount = new Decimal(dto.discount || '0');
    const finalTotal = subtotal.plus(taxAmount).minus(discountAmount);
    const isCash = dto.isCash ?? false;

    if (!isCash && pricesVisible) {
      const currentDebit = new Decimal(connection.account.totalDebit as any);
      const creditLimit = new Decimal(connection.account.creditLimit as any);
      const newDebt = currentDebit.plus(finalTotal);
      if (newDebt.greaterThan(creditLimit)) {
        throw new BadRequestException(
          `تجاوزت حد سقف المديونية. السقف: ${creditLimit.toFixed(2)}, الرصيد الحالي: ${currentDebit.toFixed(2)}, المطلوب: ${finalTotal.toFixed(2)}`,
        );
      }
    }

    const orderNumber = `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
    const currency = dto.currency || connection.account.currency || 'YER';
    const dueDate = dto.dueDate ? new Date(dto.dueDate) : connection.account.dueDate;

    return this.prisma.$transaction(async (prisma) => {
      const order = await prisma.order.create({
        data: {
          orderNumber,
          senderId,
          receiverId: dto.receiverId,
          status: 'PENDING',
          isCash,
          currency,
          dueDate: dueDate ?? undefined,
          pricesVisible,
          priceAcceptedAt: pricesVisible ? new Date() : undefined,
          subtotal: subtotal.toString(),
          tax: taxAmount.toString(),
          discount: discountAmount.toString(),
          total: finalTotal.toString(),
          notes: dto.notes,
          items: { create: itemsData },
        },
        include: { items: true, sender: true, receiver: true },
      });

      if (isCash && pricesVisible) {
        await this.financeService.recordFinancialMovement(prisma, {
          senderId,
          receiverId: dto.receiverId,
          amount: finalTotal.toString(),
          type: 'SALE',
          orderId: order.id,
          currency,
          dueDate: dueDate ?? undefined,
          note: `فاتورة نقدية #${orderNumber}`,
        });

        await this.financeService.recordFinancialMovement(prisma, {
          senderId: dto.receiverId,
          receiverId: senderId,
          amount: finalTotal.toString(),
          type: 'PAYMENT',
          orderId: order.id,
          currency,
          dueDate: dueDate ?? undefined,
          note: `سداد فوري للفاتورة النقدية #${orderNumber}`,
        });
      }

      await this.notificationsService.sendPushNotification(
        receiverBusiness.user.id,
        'طلبية جديدة',
        `لقد استلمت طلبية جديدة من ${senderBusiness.name} برقم #${orderNumber}`,
        { type: 'NEW_ORDER', orderId: order.id },
      );

      this.eventsGateway.emitToBusiness(dto.receiverId, 'NEW_ORDER', {
        id: order.id,
        orderNumber: order.orderNumber,
        senderName: senderBusiness.name,
        total: order.total,
        pricesVisible: order.pricesVisible,
      });

      await prisma.auditLog.create({
        data: {
          action: 'CREATE',
          resource: 'ORDER',
          resourceId: order.id,
          details: {
            orderNumber,
            total: finalTotal.toString(),
            isCash,
            currency,
            dueDate,
            pricesVisible,
            itemsCount: dto.items.length,
          },
        },
      });

      return this.sanitizeOrderForBusiness(order, senderId);
    });
  }

  async getOrders(businessId: string, pagination: PaginationDto) {
    const { page = 1, limit = 10 } = pagination;
    const where = { OR: [{ senderId: businessId }, { receiverId: businessId }] };

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: { sender: true, receiver: true, items: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: data.map((order) => this.sanitizeOrderForBusiness(order, businessId)),
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
        limit,
      },
    };
  }

  async getOrderById(businessId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, sender: true, receiver: true },
    });

    if (!order) {
      throw new NotFoundException('الطلبية غير موجودة');
    }

    if (order.senderId !== businessId && order.receiverId !== businessId) {
      throw new ForbiddenException('ليس لديك صلاحية للوصول إلى هذه الطلبية');
    }

    return this.sanitizeOrderForBusiness(order, businessId);
  }

  async updateOrderPrices(
    businessId: string,
    orderId: string,
    dto: UpdateOrderPricesDto,
    userType: string,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('الطلبية غير موجودة');
    }

    if (order.receiverId !== businessId) {
      throw new ForbiddenException('فقط مستقبل الطلبية يمكنه اعتماد الأسعار');
    }

    if (userType === 'individual') {
      throw new ForbiddenException('حساب المستهلك لا يعتمد أسعار طلبيات بيع');
    }

    if (order.status !== 'PENDING') {
      throw new BadRequestException('لا يمكن تعديل أسعار طلبية غير معلقة');
    }

    const priceMap = new Map(dto.items.map((item) => [item.id, new Decimal(item.unitPrice)]));
    let subtotal = new Decimal(0);
    const tax = new Decimal(dto.tax || '0');
    const discount = new Decimal(dto.discount || '0');

    await this.prisma.$transaction(async (prisma) => {
      for (const item of order.items) {
        const unitPrice = priceMap.get(item.id) ?? new Decimal(item.unitPrice as any);
        const total = unitPrice.mul(item.quantity);
        subtotal = subtotal.plus(total);
        await prisma.orderItem.update({
          where: { id: item.id },
          data: {
            unitPrice: unitPrice.toString(),
            total: total.toString(),
          },
        });
      }

      await prisma.order.update({
        where: { id: orderId },
        data: {
          subtotal: subtotal.toString(),
          tax: tax.toString(),
          discount: discount.toString(),
          total: subtotal.plus(tax).minus(discount).toString(),
          currency: dto.currency || order.currency,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : order.dueDate,
          pricesVisible: true,
          priceAcceptedAt: new Date(),
        },
      });
    });

    const updated = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, sender: true, receiver: true },
    });

    await this.notifyOrderStatusUpdate(updated, 'PRICES_ACCEPTED');
    return updated;
  }

  async updateOrderStatus(
    businessId: string,
    orderId: string,
    dto: UpdateOrderStatusDto,
    userType: string,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('الطلبية غير موجودة');
    }

    if (order.receiverId !== businessId && order.senderId !== businessId) {
      throw new ForbiddenException('ليس لديك صلاحية على هذه الطلبية');
    }

    if (userType === 'individual' && order.receiverId === businessId) {
      throw new ForbiddenException('حساب المستهلك لا يستقبل أو يعالج طلبيات بيع');
    }

    if (userType === 'individual' && dto.status !== 'CANCELLED') {
      throw new ForbiddenException('المستهلك يمكنه إلغاء طلبياته المرسلة فقط');
    }

    if (['ACCEPTED', 'REJECTED', 'COMPLETED'].includes(dto.status) && order.receiverId !== businessId) {
      throw new ForbiddenException('فقط المستقبل يمكنه تنفيذ هذا الإجراء');
    }

    if (dto.status === 'CANCELLED' && order.senderId !== businessId) {
      throw new ForbiddenException('فقط المرسل يمكنه إلغاء الطلبية');
    }

    if (dto.status === 'REJECTED' && !dto.rejectionReason) {
      throw new BadRequestException('يجب ذكر سبب الرفض عند رفض الطلبية');
    }

    if (dto.status === 'ACCEPTED' && !order.pricesVisible) {
      throw new BadRequestException('يجب اعتماد الأسعار قبل قبول الطلبية');
    }

    if (dto.status === 'ACCEPTED' && !order.isCash) {
      const updated = await this.prisma.$transaction(async (prisma) => {
        const orderUpdated = await prisma.order.update({
          where: { id: orderId },
          data: {
            status: dto.status,
            priceAcceptedAt: order.priceAcceptedAt || new Date(),
          },
        });

        await this.financeService.recordFinancialMovement(prisma, {
          senderId: order.senderId,
          receiverId: order.receiverId,
          amount: order.total,
          type: 'SALE',
          orderId: order.id,
          currency: order.currency,
          dueDate: order.dueDate ?? undefined,
          note: `فاتورة آجل #${order.orderNumber}`,
        });

        return orderUpdated;
      });

      await this.notifyOrderStatusUpdate(order, dto.status);
      return updated;
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: dto.status,
        rejectionReason: dto.status === 'REJECTED' ? dto.rejectionReason : undefined,
        rejectedById: dto.status === 'REJECTED' ? businessId : undefined,
      },
    });

    await this.notifyOrderStatusUpdate(order, dto.status, dto.rejectionReason);

    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        resource: 'ORDER',
        resourceId: orderId,
        details: {
          status: dto.status,
          previousStatus: order.status,
          rejectionReason: dto.rejectionReason,
        },
      },
    });

    return updated;
  }

  private async notifyOrderStatusUpdate(order: any, status: string, reason?: string) {
    if (!order) return;

    const targetBusiness = await this.prisma.business.findUnique({
      where: { id: order.senderId },
      include: { user: true },
    });

    if (!targetBusiness) return;

    const statusMapAr: Record<string, string> = {
      ACCEPTED: 'مقبولة',
      REJECTED: 'مرفوضة',
      COMPLETED: 'مكتملة',
      CANCELLED: 'ملغاة',
      PRICES_ACCEPTED: 'تم اعتماد الأسعار',
    };

    const title = status === 'PRICES_ACCEPTED' ? 'اعتماد أسعار الطلبية' : 'تحديث حالة الطلبية';
    let body = `تم تغيير حالة الطلبية #${order.orderNumber} إلى ${statusMapAr[status] || status}`;
    if (status === 'REJECTED' && reason) {
      body += `\nالسبب: ${reason}`;
    }

    await this.notificationsService.sendPushNotification(
      targetBusiness.user.id,
      title,
      body,
      { type: 'ORDER_STATUS_UPDATE', orderId: order.id, status },
    );

    this.eventsGateway.emitToBusiness(order.senderId, 'ORDER_STATUS_UPDATE', {
      orderId: order.id,
      status,
      orderNumber: order.orderNumber,
      rejectionReason: reason,
    });
  }

  private sanitizeOrderForBusiness(order: any, businessId: string) {
    if (!order || order.receiverId === businessId || order.pricesVisible || order.status !== 'PENDING') {
      return order;
    }

    return {
      ...order,
      subtotal: '0',
      tax: '0',
      discount: '0',
      total: '0',
      items: order.items?.map((item: any) => ({
        ...item,
        unitPrice: '0',
        total: '0',
      })) ?? [],
    };
  }
}
