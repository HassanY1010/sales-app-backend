import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../database/prisma.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CreateAdjustmentRequestDto } from './dto/create-adjustment-request.dto';

type TargetInfo = {
  targetType: 'ORDER' | 'TRANSACTION';
  targetId: string;
  senderId: string;
  receiverId: string;
  connectionId?: string | null;
  currentAmount: Decimal;
  currentDueDate?: Date | null;
  currentNote?: string | null;
  label: string;
};

@Injectable()
export class AdjustmentRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly financeService: FinanceService,
    private readonly notificationsService: NotificationsService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  async create(
    businessId: string,
    userId: string,
    dto: CreateAdjustmentRequestDto,
  ) {
    const target = await this.resolveTarget(
      businessId,
      dto.targetType,
      dto.targetId,
    );

    // Prevent duplicate pending requests on the same target
    const existingPending = await this.prisma.adjustmentRequest.findFirst({
      where: {
        targetType: dto.targetType,
        targetId: dto.targetId,
        status: 'PENDING',
      },
    });
    if (existingPending) {
      throw new BadRequestException('يوجد طلب تعديل قيد المراجعة مسبقاً لهذه الفاتورة/السند');
    }

    const receiverBusinessId =
      target.senderId === businessId ? target.receiverId : target.senderId;

    let originalData = dto.originalData;
    let requestedData = dto.requestedData;

    // Check if target is an ORDER and generate originalData snapshot automatically if not provided
    if (dto.targetType === 'ORDER' && !originalData) {
      const order = await this.prisma.order.findUnique({
        where: { id: dto.targetId },
        include: { items: true },
      });
      if (order) {
        originalData = JSON.stringify(
          order.items.map(item => ({
            itemId: item.id,
            itemName: item.itemName,
            quantity: item.quantity,
            unitPrice: (item.unitPrice ?? 0).toString(),
            total: ((item as any).total ?? (item as any).totalPrice ?? (new Decimal(item.unitPrice as any).times(item.quantity))).toString(),
          }))
        );
      }
    } else if (dto.targetType === 'TRANSACTION' && !originalData) {
      const txn = await this.prisma.transaction.findUnique({
        where: { id: dto.targetId },
      });
      if (txn) {
        originalData = JSON.stringify({
          amount: txn.amount.toString(),
          note: txn.note || '',
        });
      }
    }

    if (!dto.requestedAmount && !dto.requestedDueDate && !dto.requestedNote && !requestedData) {
      throw new BadRequestException(
        'At least one requested change is required',
      );
    }

    let requestedAmount = dto.requestedAmount
      ? new Decimal(dto.requestedAmount)
      : undefined;

    if (dto.targetType === 'ORDER' && requestedData && !dto.requestedAmount) {
      try {
        const items = JSON.parse(requestedData);
        if (Array.isArray(items)) {
          let computedSubtotal = new Decimal(0);
          for (const item of items) {
            const qty = new Decimal(item.quantity || '0');
            const price = new Decimal(item.unitPrice || '0');
            computedSubtotal = computedSubtotal.plus(qty.times(price));
          }
          const order = await this.prisma.order.findUnique({
            where: { id: dto.targetId },
          });
          if (order) {
            const tax = new Decimal(order.tax as any);
            const discount = new Decimal(order.discount as any);
            requestedAmount = computedSubtotal.plus(tax).minus(discount);
          }
        }
      } catch (_) {}
    }

    if (requestedAmount && requestedAmount.lessThan(0)) {
      throw new BadRequestException('Requested amount must be zero or greater');
    }

    const request = await this.prisma.adjustmentRequest.create({
      data: {
        requesterBusinessId: businessId,
        receiverBusinessId,
        targetType: dto.targetType,
        targetId: dto.targetId,
        requestedAmount: requestedAmount?.toString(),
        requestedDueDate: dto.requestedDueDate
          ? new Date(dto.requestedDueDate)
          : undefined,
        requestedNote: dto.requestedNote,
        originalData,
        requestedData,
        reason: dto.reason,
        createdById: userId,
      },
      include: this.includeRelations(),
    });

    const requesterBusiness = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    const requesterName = requesterBusiness?.name || 'العميل';
    const typeLabel = dto.targetType === 'ORDER' ? 'فاتورة' : 'سند';

    await this.notifyBusiness(
      receiverBusinessId,
      'طلب تعديل بانتظار المراجعة',
      `طلب العميل (${requesterName}) تعديل ${typeLabel} #${target.label.replace('order ', '').replace('transaction ', '') || target.targetId}.`,
      {
        type: 'ADJUSTMENT_REQUEST_CREATED',
        notificationType: 'amendment_request_pending',
        entityType: 'invoice',
        entityId: target.targetId,
        route: `app://invoice/${target.targetId}/amendment-request/${request.id}`,
        adjustmentRequestId: request.id,
      },
    );

    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'CREATE_AMENDMENT',
        resource: dto.targetType,
        resourceId: dto.targetId,
        details: {
          adjustmentRequestId: request.id,
          requestedAmount: requestedAmount?.toString(),
          requestedDueDate: dto.requestedDueDate,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'NOTIFICATION_SENT',
        resource: 'NOTIFICATION',
        resourceId: target.targetId,
        details: {
          notificationType: 'amendment_request_pending',
          recipientBusinessId: receiverBusinessId,
          entityId: target.targetId,
        },
      },
    });

    return request;
  }

  async list(
    businessId: string,
    query: PaginationDto & { status?: string; targetType?: string },
  ) {
    const { page = 1, limit = 20, status, targetType } = query;
    const where: any = {
      OR: [
        { requesterBusinessId: businessId },
        { receiverBusinessId: businessId },
      ],
    };

    if (status) where.status = status;
    if (targetType) where.targetType = targetType;

    const [data, total] = await Promise.all([
      this.prisma.adjustmentRequest.findMany({
        where,
        include: this.includeRelations(),
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.adjustmentRequest.count({ where }),
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

  async getById(businessId: string, id: string) {
    const request = await this.prisma.adjustmentRequest.findUnique({
      where: { id },
      include: this.includeRelations(),
    });

    if (!request) throw new NotFoundException('Adjustment request not found');
    this.ensureParticipant(businessId, request);
    return request;
  }

  async approve(businessId: string, userId: string, id: string) {
    const request = await this.getPendingForReview(businessId, id);
    const target = await this.resolveTarget(
      businessId,
      request.targetType as any,
      request.targetId,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      // Re-verify request status inside transaction to guarantee idempotency and prevent race conditions
      const currentRequest = await tx.adjustmentRequest.findUnique({
        where: { id },
      });
      if (!currentRequest) throw new NotFoundException('Adjustment request not found');
      if (currentRequest.status !== 'PENDING') {
        throw new BadRequestException(
          `Adjustment request is already ${currentRequest.status}`,
        );
      }

      // 1. Update non-amount metadata (dueDate, note) on the target record
      if (request.requestedDueDate || request.requestedNote) {
        if (request.targetType === 'ORDER') {
          await tx.order.update({
            where: { id: request.targetId },
            data: {
              dueDate: request.requestedDueDate ?? undefined,
              notes: request.requestedNote ?? undefined,
            },
          });
        } else {
          await tx.transaction.update({
            where: { id: request.targetId },
            data: {
              dueDate: request.requestedDueDate ?? undefined,
              note: request.requestedNote ?? undefined,
            },
          });
        }
      }

      // 2. Amount and Itemized changes — update target record, order items, and linked payments
      let finalAmount = request.requestedAmount
        ? new Decimal(request.requestedAmount as any)
        : target.currentAmount;

      if (request.targetType === 'ORDER') {
        const order = await tx.order.findUnique({
          where: { id: request.targetId },
        });

        if (order) {
          // 2a. Update order items if requestedData is provided
          if (request.requestedData) {
            try {
              const parsed = JSON.parse(request.requestedData);
              const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : null);
              if (Array.isArray(items) && items.length > 0) {
                const existingItems = await tx.orderItem.findMany({
                  where: { orderId: request.targetId },
                });

                for (let i = 0; i < items.length; i++) {
                  const item = items[i];
                  const itemId = item.id || item.itemId;
                  const qty = Math.max(1, parseInt(item.quantity?.toString() || '1', 10));
                  const unitPrice = item.unitPrice !== undefined ? item.unitPrice.toString() : '0';
                  const itemTotal = new Decimal(qty).times(new Decimal(unitPrice)).toString();
                  const unit = item.unit || undefined;

                  const match = (itemId && itemId !== request.targetId)
                    ? existingItems.find((e) => e.id === itemId)
                    : (i < existingItems.length ? existingItems[i] : null);

                  const isPlaceholderName = !item.itemName || 
                    item.itemName === 'صنف' || 
                    item.itemName === 'صنف الفاتورة' || 
                    item.itemName === 'تفاصيل الفاتورة' ||
                    item.itemName.startsWith('فاتورة مبيعات');
                  
                  const resolvedItemName = isPlaceholderName && match
                    ? match.itemName
                    : (item.itemName || match?.itemName || 'صنف');

                  if (match) {
                    await tx.orderItem.update({
                      where: { id: match.id },
                      data: {
                        itemName: resolvedItemName,
                        quantity: qty,
                        unitPrice,
                        total: itemTotal,
                        unit: unit || match.unit,
                      },
                    });
                  } else {
                    await tx.orderItem.create({
                      data: {
                        orderId: request.targetId,
                        itemName: resolvedItemName,
                        quantity: qty,
                        unitPrice,
                        total: itemTotal,
                        unit,
                      },
                    });
                  }
                }
              }
            } catch (_) {}
          }

          // 2b. Recalculate subtotal and final total from current order items
          let newDiscount = new Decimal((order.discount ?? '0') as any);
          let newPaidAmount = new Decimal((order.paidAmount ?? '0') as any);
          if (request.requestedData) {
            try {
              const parsed = JSON.parse(request.requestedData);
              if (parsed.discount !== undefined) {
                newDiscount = new Decimal(parsed.discount || '0');
              }
              if (parsed.paidAmount !== undefined) {
                newPaidAmount = new Decimal(parsed.paidAmount || '0');
              }
            } catch (_) {}
          }

          const currentItems = await tx.orderItem.findMany({
            where: { orderId: request.targetId },
          });
          let newSubtotal = new Decimal(0);
          if (currentItems.length > 0) {
            newSubtotal = currentItems.reduce(
              (sum, item) => sum.plus(new Decimal(item.total.toString())),
              new Decimal(0),
            );
            const tax = new Decimal((order.tax ?? '0') as any);
            finalAmount = newSubtotal.plus(tax).minus(newDiscount);
          } else if (request.requestedAmount) {
            finalAmount = new Decimal(request.requestedAmount as any);
            newSubtotal = finalAmount;
          } else {
            finalAmount = target.currentAmount;
            newSubtotal = finalAmount;
          }

          // 2c. payment-status recalculation and balance reconciliation
          let finalPaid = newPaidAmount;
          if (finalAmount.lessThan(finalPaid)) {
            finalPaid = finalAmount;
            // Update linked PAYMENT transaction (if any exists for partial payment)
            const linkedPayment = await tx.transaction.findFirst({
              where: { orderId: request.targetId, transactionType: 'PAYMENT' },
            });
            if (linkedPayment) {
              await tx.transaction.update({
                where: { id: linkedPayment.id },
                data: { amount: finalAmount.toString() },
              });
            }
          }

          // 2d. Save updated invoice total, discount, paidAmount and subtotal
          await tx.order.update({
            where: { id: request.targetId },
            data: {
              subtotal: newSubtotal.toString(),
              discount: newDiscount.toString(),
              total: finalAmount.toString(),
              paidAmount: finalPaid.toString(),
            },
          });
        }

        // 2e. Update the linked SALE / PURCHASE transaction's amount to new total
        const linkedTxn = await tx.transaction.findFirst({
          where: {
            orderId: request.targetId,
            transactionType: { in: ['SALE', 'PURCHASE'] },
          },
        });
        if (linkedTxn) {
          await tx.transaction.update({
            where: { id: linkedTxn.id },
            data: { amount: finalAmount.toString() },
          });
        }
      } else {
        // For TRANSACTION targets (receipt vouchers)
        let noteUpdate: string | undefined;
        if (request.requestedData) {
          try {
            const txnData = JSON.parse(request.requestedData);
            if (txnData.amount) {
              finalAmount = new Decimal(txnData.amount);
            }
            if (txnData.note) {
              noteUpdate = txnData.note;
            }
          } catch (_) {}
        }

        await tx.transaction.update({
          where: { id: request.targetId },
          data: {
            amount: finalAmount.toString(),
            note: noteUpdate ?? undefined,
          },
        });
      }

      // 3. Rebuild account balance from ledger ground truth
      let connection = target.connectionId
        ? await tx.connection.findUnique({
            where: { id: target.connectionId },
            include: { account: true },
          })
        : null;

      if (!connection) {
        connection = await tx.connection.findFirst({
          where: {
            OR: [
              { requesterId: target.senderId, receiverId: target.receiverId },
              { requesterId: target.receiverId, receiverId: target.senderId },
            ],
            status: { in: ['ACCEPTED', 'ACTIVE', 'accepted', 'active'] },
          },
          include: { account: true },
        });
      }

      if (connection?.account) {
        await this.financeService.rebuildAccountBalance(
          connection.account.id,
          tx,
        );
      }

      const approved = await tx.adjustmentRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedById: userId,
          reviewedAt: new Date(),
        },
        include: this.includeRelations(),
      });

      await tx.auditLog.create({
        data: {
          userId,
          businessId,
          action: 'APPROVE_AMENDMENT',
          resource: request.targetType,
          resourceId: request.targetId,
          details: {
            adjustmentRequestId: id,
            requestedAmount: request.requestedAmount?.toString(),
            finalAmount: finalAmount.toString(),
          },
        },
      });

      return approved;
    });

    await this.notifyBusiness(
      request.requesterBusinessId,
      'تمت الموافقة على طلب التعديل',
      `تمت الموافقة على طلب التعديل الخاص بـ ${target.label}.`,
      {
        type: 'ADJUSTMENT_REQUEST_APPROVED',
        notificationType: 'amendment_request_approved',
        entityType: 'invoice',
        entityId: target.targetId,
        route: `app://invoice/${target.targetId}`,
        adjustmentRequestId: id,
      },
    );

    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'NOTIFICATION_SENT',
        resource: 'NOTIFICATION',
        resourceId: target.targetId,
        details: {
          notificationType: 'amendment_request_approved',
          recipientBusinessId: request.requesterBusinessId,
          entityId: target.targetId,
        },
      },
    });

    this.eventsGateway.emitToBusiness(request.requesterBusinessId, 'ACCOUNT_UPDATED', {
      targetType: request.targetType,
      targetId: request.targetId,
      status: 'APPROVED',
    });
    this.eventsGateway.emitToBusiness(request.receiverBusinessId, 'ACCOUNT_UPDATED', {
      targetType: request.targetType,
      targetId: request.targetId,
      status: 'APPROVED',
    });

    return updated;
  }

  async reject(
    businessId: string,
    userId: string,
    id: string,
    rejectionReason: string,
  ) {
    if (!rejectionReason?.trim() || rejectionReason.trim().length < 5) {
      throw new BadRequestException('Rejection reason is required');
    }

    const request = await this.getPendingForReview(businessId, id);

    const rejected = await this.prisma.adjustmentRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectionReason: rejectionReason.trim(),
        reviewedById: userId,
        reviewedAt: new Date(),
      },
      include: this.includeRelations(),
    });

    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'REJECT_AMENDMENT',
        resource: request.targetType,
        resourceId: request.targetId,
        details: {
          adjustmentRequestId: id,
          rejectionReason: rejectionReason.trim(),
        },
      },
    });

    await this.notifyBusiness(
      request.requesterBusinessId,
      'تم رفض طلب التعديل',
      `تم رفض طلب التعديل. السبب: ${rejectionReason.trim()}`,
      {
        type: 'ADJUSTMENT_REQUEST_REJECTED',
        notificationType: 'amendment_request_rejected',
        entityType: 'invoice',
        entityId: request.targetId,
        route: `app://invoice/${request.targetId}`,
        adjustmentRequestId: id,
      },
    );

    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'NOTIFICATION_SENT',
        resource: 'NOTIFICATION',
        resourceId: request.targetId,
        details: {
          notificationType: 'amendment_request_rejected',
          recipientBusinessId: request.requesterBusinessId,
          entityId: request.targetId,
        },
      },
    });

    this.eventsGateway.emitToBusiness(request.requesterBusinessId, 'ACCOUNT_UPDATED', {
      targetType: request.targetType,
      targetId: request.targetId,
      status: 'REJECTED',
    });
    this.eventsGateway.emitToBusiness(request.receiverBusinessId, 'ACCOUNT_UPDATED', {
      targetType: request.targetType,
      targetId: request.targetId,
      status: 'REJECTED',
    });

    return rejected;
  }

  private async getPendingForReview(businessId: string, id: string) {
    const request = await this.prisma.adjustmentRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException('Adjustment request not found');
    if (request.receiverBusinessId !== businessId) {
      throw new ForbiddenException(
        'Only the receiving party can review this request',
      );
    }
    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `Adjustment request is already ${request.status}`,
      );
    }
    return request;
  }

  private async resolveTarget(
    businessId: string,
    targetType: 'ORDER' | 'TRANSACTION',
    targetId: string,
  ): Promise<TargetInfo> {
    if (targetType === 'ORDER') {
      const order = await this.prisma.order.findUnique({
        where: { id: targetId },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (order.senderId !== businessId && order.receiverId !== businessId) {
        throw new ForbiddenException('You do not have access to this order');
      }
      return {
        targetType,
        targetId,
        senderId: order.senderId,
        receiverId: order.receiverId,
        connectionId: order.connectionId,
        currentAmount: new Decimal(order.total as any),
        currentDueDate: order.dueDate,
        currentNote: order.notes,
        label: `order ${order.orderNumber}`,
      };
    }

    const transaction = await this.prisma.transaction.findUnique({
      where: { id: targetId },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');
    if (
      transaction.senderId !== businessId &&
      transaction.receiverId !== businessId
    ) {
      throw new ForbiddenException(
        'You do not have access to this transaction',
      );
    }

    return {
      targetType,
      targetId,
      senderId: transaction.senderId,
      receiverId: transaction.receiverId,
      connectionId: transaction.connectionId,
      currentAmount: new Decimal(transaction.amount as any),
      currentDueDate: transaction.dueDate,
      currentNote: transaction.note,
      label: `transaction ${transaction.voucherNumber ?? transaction.id}`,
    };
  }

  private ensureParticipant(businessId: string, request: any) {
    if (
      request.requesterBusinessId !== businessId &&
      request.receiverBusinessId !== businessId
    ) {
      throw new ForbiddenException(
        'You do not have access to this adjustment request',
      );
    }
  }

  private async notifyBusiness(
    businessId: string,
    title: string,
    body: string,
    data: Record<string, any>,
  ) {
    await this.notificationsService.notifyBusiness(
      businessId,
      title,
      body,
      data,
    );
  }

  private includeRelations() {
    return {
      requesterBusiness: { select: { id: true, name: true } },
      receiverBusiness: { select: { id: true, name: true } },
      createdBy: { select: { id: true, fullName: true, email: true } },
      reviewedBy: { select: { id: true, fullName: true, email: true } },
    };
  }
}
