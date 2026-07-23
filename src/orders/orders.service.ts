import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../database/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  UpdateOrderPricesDto,
  UpdateOrderStatusDto,
} from './dto/update-order-status.dto';
import { FinanceService } from '../finance/finance.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { InvoiceNumberService } from '../common/invoice-number.service';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly financeService: FinanceService,
    private readonly notificationsService: NotificationsService,
    private readonly eventsGateway: EventsGateway,
    private readonly invoiceNumberService: InvoiceNumberService,
  ) {}

  async createOrder(senderId: string, dto: CreateOrderDto, userType: string) {
    if (senderId === dto.receiverId) {
      throw new BadRequestException('لا يمكنك إنشاء طلبية لنفسك');
    }

    // ── Idempotency guard: if this clientId was already processed, return the existing order ──
    if (dto.clientId) {
      const existing = await this.prisma.order.findUnique({
        where: { clientId: dto.clientId },
        include: { items: true, sender: true, receiver: true },
      });
      if (existing) {
        return existing; // Duplicate request — safe to return existing record
      }
    }

    const connection = await this.prisma.connection.findFirst({
      where: {
        OR: [
          { requesterId: senderId, receiverId: dto.receiverId, connectionType: 'SUPPLIER' },
          { requesterId: dto.receiverId, receiverId: senderId, connectionType: 'CUSTOMER' },
        ],
        status: 'ACCEPTED',
      },
      include: { account: true },
    });

    if (!connection?.account) {
      throw new BadRequestException(
        'يجب وجود ارتباط مقبول وحساب مالي لإنشاء طلبية',
      );
    }

    const [senderBusiness, receiverBusiness] = await Promise.all([
      this.prisma.business.findUnique({
        where: { id: senderId },
        include: { user: true },
      }),
      this.prisma.business.findUnique({
        where: { id: dto.receiverId },
        include: { user: true },
      }),
    ]);

    if (!senderBusiness || !receiverBusiness) {
      throw new BadRequestException('الطرف المرسل أو المستقبل غير صالح');
    }

    if (
      userType === 'individual' &&
      receiverBusiness.user.userType !== 'business'
    ) {
      throw new ForbiddenException(
        'المستهلك يمكنه إرسال طلبيات شراء لحسابات تجارية فقط',
      );
    }

    const pricesVisible =
      dto.pricesVisible ?? (connection.showPrices || userType === 'business');
    let subtotal = new Decimal(0);
    const itemsData = dto.items.map((item) => {
      const unitPrice = pricesVisible
        ? new Decimal(item.unitPrice || '0')
        : new Decimal(0);
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
    const paidAmount = isCash
      ? finalTotal
      : Decimal.min(new Decimal(dto.paidAmount || '0'), finalTotal);

    if (!isCash && pricesVisible) {
      const currentDebit = new Decimal(connection.account.totalDebit as any);
      const creditLimit = new Decimal(connection.account.creditLimit as any);
      const remainingDebt = finalTotal.minus(paidAmount);
      const newDebt = currentDebit.plus(remainingDebt);
      
      if (creditLimit.greaterThan(0) && newDebt.greaterThan(creditLimit)) {
        const available = creditLimit.minus(currentDebit);
        if (paidAmount.greaterThan(0)) {
          throw new BadRequestException(
            `المبلغ المتبقي (${remainingDebt.toFixed(2)}) يتجاوز الرصيد المتاح ضمن سقف المديونية. المتاح حالياً: ${available.toFixed(2)}.`
          );
        } else {
          throw new BadRequestException(
            `تم تجاوز سقف المديونية. الرصيد الحالي: ${currentDebit.toFixed(2)}، المبلغ المضاف: ${remainingDebt.toFixed(2)}، الرصيد المتوقع: ${newDebt.toFixed(2)}، سقف المديونية: ${creditLimit.toFixed(2)}.`
          );
        }
      }
    }

    const currency = dto.currency || connection.account.currency || 'YER';
    const dueDate = dto.dueDate
      ? new Date(dto.dueDate)
      : connection.account.dueDate;

    return this.prisma.$transaction(async (prisma) => {
      // Generate sequential invoice number atomically inside the transaction
      const orderNumber = await this.invoiceNumberService.getNextInvoiceNumber(prisma);
      const order = await prisma.order.create({
        data: {
          orderNumber,
          clientId: dto.clientId ?? undefined,  // Store device UUID for idempotency
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
          paidAmount: paidAmount.toString(),
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
          note: `فاتورة نقدية رقم ${orderNumber}`,
          connectionId: connection.id,
        });

        await this.financeService.recordFinancialMovement(prisma, {
          senderId: dto.receiverId,
          receiverId: senderId,
          amount: finalTotal.toString(),
          type: 'PAYMENT',
          orderId: order.id,
          currency,
          dueDate: dueDate ?? undefined,
          note: `سداد فوري للفاتورة النقدية رقم ${orderNumber}`,
          connectionId: connection.id,
        });
      }

      await this.notificationsService.sendPushNotification(
        receiverBusiness.user.id,
        'طلبية جديدة',
        `لقد استلمت طلبية جديدة من ${senderBusiness.name} برقم ${orderNumber}`,
        {
          type: 'NEW_ORDER',
          notificationType: 'new_order',
          entityType: 'order',
          entityId: order.id,
          orderId: order.id,
          route: `/receive-orders/incoming?orderId=${order.id}`,
        },
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
            paidAmount: paidAmount.toString(),
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
    const where = {
      OR: [{ senderId: businessId }, { receiverId: businessId }],
    };

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
      data: data.map((order) =>
        this.sanitizeOrderForBusiness(order, businessId),
      ),
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

    const priceMap = new Map(
      dto.items.map((item) => [item.id, new Decimal(item.unitPrice)]),
    );
    let subtotal = new Decimal(0);
    const tax = new Decimal(dto.tax || '0');
    const discount = new Decimal(dto.discount || '0');

    await this.prisma.$transaction(async (prisma) => {
      for (const item of order.items) {
        const unitPrice =
          priceMap.get(item.id) ?? new Decimal(item.unitPrice as any);
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

      const paidAmount = new Decimal(dto.paidAmount || order.paidAmount as any || '0');

      await prisma.order.update({
        where: { id: orderId },
        data: {
          subtotal: subtotal.toString(),
          tax: tax.toString(),
          discount: discount.toString(),
          paidAmount: paidAmount.toString(),
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

    if (userType === 'individual') {
      if (order.receiverId === businessId) {
        if (!['ACCEPTED', 'REJECTED'].includes(dto.status)) {
          throw new ForbiddenException('المستهلك يمكنه فقط قبول أو رفض الفاتورة المستلمة');
        }
      } else {
        if (dto.status !== 'CANCELLED' && dto.status !== 'RESUBMITTED') {
          throw new ForbiddenException('المستهلك يمكنه إلغاء أو إعادة إرساب طلبياته فقط');
        }
      }
    }

    if (
      ['ACCEPTED', 'REJECTED', 'COMPLETED'].includes(dto.status) &&
      order.receiverId !== businessId
    ) {
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

    // --- CASE 1 & 2: ACCEPTING ORDER ---
    if (dto.status === 'ACCEPTED') {
      const result = await this.prisma.$transaction(async (prisma) => {
        // Advisory Lock to prevent race conditions
        await prisma.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${order.senderId || ''} || '-' || ${order.receiverId || ''}))
        `;

        const connection = await prisma.connection.findFirst({
          where: {
            OR: [
              { requesterId: order.senderId, receiverId: order.receiverId, connectionType: 'SUPPLIER' },
              { requesterId: order.receiverId, receiverId: order.senderId, connectionType: 'CUSTOMER' },
            ],
            status: 'ACCEPTED',
          },
          include: { account: true },
        });

        // Validate credit limit if NOT cash
        if (!order.isCash && connection?.account) {
          const currentDebit = new Decimal(connection.account.totalDebit as any);
          const creditLimit = new Decimal(connection.account.creditLimit as any);
          const orderTotal = new Decimal(order.total as any);
          const paidAmount = new Decimal((order as any).paidAmount || '0');
          const remainingDebt = orderTotal.minus(paidAmount);
          const newDebt = currentDebit.plus(remainingDebt);

          if (creditLimit.greaterThan(0) && newDebt.greaterThan(creditLimit)) {
            // Validation failed! Reject order automatically
            return {
              isRejected: true,
              reason: 'Credit Limit Exceeded',
            };
          }
        }

        // Accept order
        const orderUpdated = await prisma.order.update({
          where: { id: orderId },
          data: {
            status: 'ACCEPTED',
            priceAcceptedAt: order.priceAcceptedAt || new Date(),
          },
        });

        // Check if invoice already exists
        const existingInvoice = await prisma.transaction.findFirst({
          where: { orderId, transactionType: 'SALE' },
        });

        let invoiceId = existingInvoice?.id;
        let invoiceNumber = existingInvoice?.voucherNumber;

        if (!existingInvoice) {
          // Record SALE movement (Invoice)
          const movement = await this.financeService.recordFinancialMovement(prisma, {
            senderId: order.senderId,
            receiverId: order.receiverId,
            amount: order.total,
            type: 'SALE',
            orderId: order.id,
            currency: order.currency,
            dueDate: order.dueDate ?? undefined,
            note: order.isCash ? `فاتورة نقدية #${order.orderNumber}` : `فاتورة آجل #${order.orderNumber}`,
            connectionId: connection!.id,
          });

          invoiceId = movement.transaction.id;
          invoiceNumber = movement.transaction.voucherNumber;

          // Record payment for cash orders or partial paidAmount
          const paidAmount = order.isCash ? new Decimal(order.total as any) : new Decimal((order as any).paidAmount || '0');
          if (paidAmount.greaterThan(0)) {
            await this.financeService.recordFinancialMovement(prisma, {
              senderId: order.receiverId,
              receiverId: order.senderId,
              amount: paidAmount.toString(),
              type: 'PAYMENT',
              orderId: order.id,
              currency: order.currency,
              dueDate: order.dueDate ?? undefined,
              note: order.isCash ? `سداد فوري للفاتورة النقدية #${order.orderNumber}` : `سداد جزئي للفاتورة الآجلة #${order.orderNumber}`,
              connectionId: connection!.id,
            });
          }
        }

        // Link invoiceId to order
        if (invoiceId) {
          await prisma.order.update({
            where: { id: orderId },
            data: { invoiceId },
          });
        }

        return {
          isRejected: false,
          order: orderUpdated,
          invoiceId,
          invoiceNumber,
        };
      });

      if (result.isRejected) {
        // Change status to REJECTED due to credit limit
        const updated = await this.prisma.order.update({
          where: { id: orderId },
          data: {
            status: 'REJECTED',
            rejectionReason: 'Credit Limit Exceeded',
            rejectedById: businessId,
          },
        });

        await this.notifyOrderStatusUpdate(order, 'REJECTED', 'Credit Limit Exceeded', true);

        await this.prisma.auditLog.create({
          data: {
            action: 'UPDATE',
            resource: 'ORDER',
            resourceId: orderId,
            details: {
              status: 'REJECTED',
              previousStatus: order.status,
              rejectionReason: 'Credit Limit Exceeded',
            },
          },
        });

        return updated;
      } else {
        // Accepted successfully
        const targetBusiness = await this.prisma.business.findUnique({
          where: { id: order.senderId },
          include: { user: true },
        });

        if (targetBusiness) {
          const title = 'تم قبول الطلبية وتحويلها لفاتورة';
          const body = `تم قبول طلبيتك رقم #${order.orderNumber} وتحويلها لفاتورة مبيعات رقم #${result.invoiceNumber}`;
          await this.notificationsService.sendPushNotification(
            targetBusiness.user.id,
            title,
            body,
            {
              type: 'ORDER_ACCEPTED_CONVERTED',
              notificationType: 'order_accepted_converted',
              entityType: 'order',
              entityId: order.id,
              orderId: order.id,
              invoiceId: result.invoiceId,
              invoiceNumber: result.invoiceNumber,
              route: `/orders/${result.invoiceId || order.id}`,
            },
          );

          this.eventsGateway.emitToBusiness(order.senderId, 'ORDER_STATUS_UPDATE', {
            orderId: order.id,
            status: 'ACCEPTED',
            orderNumber: order.orderNumber,
            invoiceId: result.invoiceId,
            invoiceNumber: result.invoiceNumber,
          });
        }

        await this.prisma.auditLog.create({
          data: {
            action: 'UPDATE',
            resource: 'ORDER',
            resourceId: orderId,
            details: {
              status: 'ACCEPTED',
              previousStatus: order.status,
              invoiceId: result.invoiceId,
              invoiceNumber: result.invoiceNumber,
            },
          },
        });

        return result.order;
      }
    }

    // --- CASE 3: RESUBMITTING ORDER ---
    if (dto.status === 'RESUBMITTED') {
      const updated = await this.prisma.order.update({
        where: { id: orderId },
        data: {
          status: 'PENDING',
          rejectionReason: null,
          rejectedById: null,
          invoiceId: null,
        },
      });

      const receiverBusiness = await this.prisma.business.findUnique({
        where: { id: order.receiverId },
        include: { user: true },
      });

      const senderBusiness = await this.prisma.business.findUnique({
        where: { id: order.senderId },
      });

      if (receiverBusiness && senderBusiness) {
        await this.notificationsService.sendPushNotification(
          receiverBusiness.user.id,
          'إعادة تقديم طلبية شحن',
          `أعاد العميل ${senderBusiness.name} تقديم طلبيته رقم #${order.orderNumber}`,
          {
            type: 'ORDER_RESUBMITTED',
            notificationType: 'order_resubmitted',
            entityType: 'order',
            entityId: order.id,
            orderId: order.id,
            route: `/receive-orders/incoming?orderId=${order.id}`,
          },
        );

        this.eventsGateway.emitToBusiness(order.receiverId, 'NEW_ORDER', {
          id: order.id,
          orderNumber: order.orderNumber,
          senderName: senderBusiness.name,
          total: order.total,
          pricesVisible: order.pricesVisible,
        });
      }

      await this.prisma.auditLog.create({
        data: {
          action: 'UPDATE',
          resource: 'ORDER',
          resourceId: orderId,
          details: {
            status: 'RESUBMITTED',
            previousStatus: order.status,
          },
        },
      });

      return updated;
    }

    // --- GENERAL CASE: MANUAL REJECTION, CANCEL, COMPLETED ---
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: dto.status,
        rejectionReason:
          dto.status === 'REJECTED' ? dto.rejectionReason : undefined,
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

  private async notifyOrderStatusUpdate(
    order: any,
    status: string,
    reason?: string,
    isCreditLimitRejection = false,
  ) {
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

    const title =
      status === 'PRICES_ACCEPTED'
        ? 'اعتماد أسعار الطلبية'
        : 'تحديث حالة الطلبية';
    let body = `تم تغيير حالة الطلبية #${order.orderNumber} إلى ${statusMapAr[status] || status}`;
    if (status === 'REJECTED' && reason) {
      body += `\nالسبب: ${reason}`;
    }

    const notificationType = (() => {
      if (isCreditLimitRejection) return 'order_rejected_credit_limit';
      if (status === 'REJECTED') return 'order_rejected';
      if (status === 'PRICES_ACCEPTED') return 'order_prices_accepted';
      return 'order_status_update';
    })();

    await this.notificationsService.sendPushNotification(
      targetBusiness.user.id,
      title,
      body,
      {
        type: notificationType.toUpperCase(),
        notificationType,
        entityType: 'order',
        entityId: order.id,
        orderId: order.id,
        status,
        rejectionReason: reason,
        route: notificationType === 'order_rejected' || notificationType === 'order_rejected_credit_limit'
          ? `/purchase-orders/received-list?orderId=${order.id}`
          : `/orders/${order.id}`,
      },
    );

    this.eventsGateway.emitToBusiness(order.senderId, 'ORDER_STATUS_UPDATE', {
      orderId: order.id,
      status,
      orderNumber: order.orderNumber,
      rejectionReason: reason,
    });
  }

  private sanitizeOrderForBusiness(order: any, businessId: string) {
    if (
      !order ||
      order.receiverId === businessId ||
      order.pricesVisible ||
      order.status !== 'PENDING'
    ) {
      return order;
    }

    return {
      ...order,
      subtotal: '0',
      tax: '0',
      discount: '0',
      total: '0',
      items:
        order.items?.map((item: any) => ({
          ...item,
          unitPrice: '0',
          total: '0',
        })) ?? [],
    };
  }
}
