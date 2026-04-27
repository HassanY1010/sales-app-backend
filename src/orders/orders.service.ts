import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { Decimal } from 'decimal.js';
import { FinanceService } from '../finance/finance.service';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly financeService: FinanceService,
  ) {}

  async createOrder(senderId: string, dto: CreateOrderDto) {
    if (senderId === dto.receiverId) {
      throw new BadRequestException('لا يمكنك إنشاء طلبية لنفسك');
    }

    // Verify there is an active connection
    const connection = await this.prisma.connection.findFirst({
      where: {
        OR: [
          { requesterId: senderId, receiverId: dto.receiverId },
          { requesterId: dto.receiverId, receiverId: senderId },
        ],
        status: 'ACCEPTED',
      },
      include: {
        account: true,
      },
    });

    if (!connection || !connection.account) {
      throw new BadRequestException('يجب أن يكون لديك ارتباط مقبول مع هذا النشاط لإنشاء طلبية');
    }

    let subtotal = new Decimal(0);
    const itemsData = dto.items.map((item) => {
      const unitPrice = new Decimal(item.unitPrice);
      const total = unitPrice.mul(item.quantity);
      subtotal = subtotal.plus(total);
      return {
        ...item,
        unitPrice: unitPrice.toString(),
        total: total.toString(),
      };
    });

    const taxAmount = new Decimal(dto.tax || 0);
    const discountAmount = new Decimal(dto.discount || 0);
    const finalTotal = subtotal.plus(taxAmount).minus(discountAmount);

    // ── Credit Limit Check (for non-cash / آجل orders) ──
    const isCash = dto.isCash ?? false;
    if (!isCash) {
      const currentDebit = new Decimal(connection.account.totalDebit as any);
      const creditLimit = new Decimal(connection.account.creditLimit as any);
      const newDebt = currentDebit.plus(finalTotal);

      if (newDebt.greaterThan(creditLimit)) {
        throw new BadRequestException(
          `تجاوزت حد سقف المديونية. السقف: ${creditLimit.toFixed(2)}, الرصيد الحالي: ${currentDebit.toFixed(2)}, المطلوب: ${finalTotal.toFixed(2)}`,
        );
      }
    }

    // Generate unique order number
    const orderNumber = `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

    return this.prisma.$transaction(async (prisma) => {
      // 1. Create the Order
      const order = await prisma.order.create({
        data: {
          orderNumber,
          senderId,
          receiverId: dto.receiverId,
          isCash,
          subtotal: subtotal.toString(),
          tax: taxAmount.toString(),
          discount: discountAmount.toString(),
          total: finalTotal.toString(),
          notes: dto.notes,
          items: {
            create: itemsData,
          },
        },
        include: {
          items: true,
        },
      });

      // 2. If isCash, create a SALE transaction and an immediate PAYMENT to keep balance zero
      if (isCash) {
        // Record SALE
        await this.financeService.recordFinancialMovement(prisma, {
          senderId,
          receiverId: dto.receiverId,
          amount: finalTotal.toString() as any,
          type: 'SALE',
          orderId: order.id,
          note: `فاتورة نقدية #${orderNumber}`,
        });

        // Record immediate PAYMENT
        await this.financeService.recordFinancialMovement(prisma, {
          senderId: dto.receiverId,
          receiverId: senderId,
          amount: finalTotal.toString() as any,
          type: 'PAYMENT',
          orderId: order.id,
          note: `سداد فوري للفاتورة النقدية #${orderNumber}`,
        });
      }

      // 3. Audit log
      await prisma.auditLog.create({
        data: {
          action: 'CREATE',
          resource: 'ORDER',
          resourceId: order.id,
          details: {
            orderNumber,
            total: finalTotal.toString(),
            isCash,
            itemsCount: dto.items.length,
          },
        },
      });

      return order;
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
        include: {
          sender: true,
          receiver: true,
          items: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data,
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
      include: {
        items: true,
        sender: true,
        receiver: true,
      },
    });

    if (!order) {
      throw new NotFoundException('الطلبية غير موجودة');
    }

    if (order.senderId !== businessId && order.receiverId !== businessId) {
      throw new ForbiddenException('ليس لديك صلاحية للوصول إلى هذه الطلبية');
    }

    return order;
  }

  async updateOrderStatus(businessId: string, orderId: string, dto: UpdateOrderStatusDto) {
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

    // Receiver can accept/reject/complete
    if (dto.status === 'ACCEPTED' || dto.status === 'REJECTED' || dto.status === 'COMPLETED') {
      if (order.receiverId !== businessId) {
        throw new ForbiddenException('فقط المستقبل يمكنه تنفيذ هذا الإجراء');
      }
    }

    // Sender can cancel
    if (dto.status === 'CANCELLED') {
      if (order.senderId !== businessId) {
        throw new ForbiddenException('فقط المرسل يمكنه إلغاء الطلبية');
      }
    }

    // If accepting a credit order, auto-create a SALE transaction
    if (dto.status === 'ACCEPTED' && !order.isCash) {
      return this.prisma.$transaction(async (prisma) => {
        const updated = await prisma.order.update({
          where: { id: orderId },
          data: { status: dto.status },
        });

        // Create SALE transaction for accepted credit orders via FinanceService
        await this.financeService.recordFinancialMovement(prisma, {
          senderId: order.senderId,
          receiverId: order.receiverId,
          amount: order.total,
          type: 'SALE',
          orderId: order.id,
          note: `فاتورة آجل #${order.orderNumber}`,
        });

        // Audit log
        await prisma.auditLog.create({
          data: {
            action: 'UPDATE',
            resource: 'ORDER',
            resourceId: orderId,
            details: { status: dto.status, previousStatus: order.status },
          },
        });

        return updated;
      });
    }

    // Default status update
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: dto.status },
    });

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        resource: 'ORDER',
        resourceId: orderId,
        details: { status: dto.status, previousStatus: order.status },
      },
    });

    return updated;
  }
}

