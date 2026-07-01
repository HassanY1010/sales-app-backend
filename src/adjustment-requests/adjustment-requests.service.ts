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
import { PaginationDto } from '../common/dto/pagination.dto';
import { CreateAdjustmentRequestDto } from './dto/create-adjustment-request.dto';

type TargetInfo = {
  targetType: 'ORDER' | 'TRANSACTION';
  targetId: string;
  senderId: string;
  receiverId: string;
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
    const receiverBusinessId =
      target.senderId === businessId ? target.receiverId : target.senderId;

    if (!dto.requestedAmount && !dto.requestedDueDate && !dto.requestedNote) {
      throw new BadRequestException(
        'At least one requested change is required',
      );
    }

    const requestedAmount = dto.requestedAmount
      ? new Decimal(dto.requestedAmount)
      : undefined;
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
        reason: dto.reason,
        createdById: userId,
      },
      include: this.includeRelations(),
    });

    await this.notifyBusiness(
      receiverBusinessId,
      'طلب تعديل بانتظار المراجعة',
      `يوجد طلب تعديل جديد على ${target.label}.`,
      { type: 'ADJUSTMENT_REQUEST_CREATED', adjustmentRequestId: request.id },
    );

    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'CREATE',
        resource: 'ADJUSTMENT_REQUEST',
        resourceId: request.id,
        details: {
          targetType: dto.targetType,
          targetId: dto.targetId,
          requestedAmount: requestedAmount?.toString(),
          requestedDueDate: dto.requestedDueDate,
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

      // 2. Amount change — update the actual record, then rebuild balance
      if (request.requestedAmount) {
        const requestedAmount = new Decimal(request.requestedAmount as any);
        const difference = requestedAmount.minus(target.currentAmount);

        if (request.targetType === 'ORDER') {
          // 2a. Update the Order's total directly
          await tx.order.update({
            where: { id: request.targetId },
            data: { total: requestedAmount.toString() },
          });

          // 2b. Update the linked SALE transaction's amount (if any)
          const linkedTransaction = await tx.transaction.findFirst({
            where: { orderId: request.targetId, transactionType: 'SALE' },
          });
          if (linkedTransaction) {
            await tx.transaction.update({
              where: { id: linkedTransaction.id },
              data: { amount: requestedAmount.toString() },
            });
          }
        } else {
          // 2c. Update the Transaction's amount directly
          await tx.transaction.update({
            where: { id: request.targetId },
            data: { amount: requestedAmount.toString() },
          });
        }

        // 3. Record ledger ADJUSTMENT entry for the difference (only if non-zero)
        if (!difference.isZero()) {
          const increasesOriginalDirection = difference.greaterThan(0);
          await this.financeService.recordFinancialMovement(tx, {
            senderId: increasesOriginalDirection
              ? target.senderId
              : target.receiverId,
            receiverId: increasesOriginalDirection
              ? target.receiverId
              : target.senderId,
            amount: difference.abs().toString(),
            type: 'ADJUSTMENT',
            note: `Approved adjustment request ${request.id} for ${target.label}`,
            userId,
          });
        }

        // 4. Rebuild account balance from ledger ground truth
        const connection = await tx.connection.findFirst({
          where: {
            OR: [
              { requesterId: target.senderId, receiverId: target.receiverId },
              { requesterId: target.receiverId, receiverId: target.senderId },
            ],
            status: 'ACCEPTED',
          },
          include: { account: true },
        });

        if (connection?.account) {
          await this.financeService.rebuildAccountBalance(
            connection.account.id,
            tx,
          );
        }
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
          action: 'APPROVE',
          resource: 'ADJUSTMENT_REQUEST',
          resourceId: id,
          details: {
            targetType: request.targetType,
            targetId: request.targetId,
            requestedAmount: request.requestedAmount?.toString(),
          },
        },
      });

      return approved;
    });

    await this.notifyBusiness(
      request.requesterBusinessId,
      'تمت الموافقة على طلب التعديل',
      `تمت الموافقة على طلب التعديل الخاص بـ ${target.label}.`,
      { type: 'ADJUSTMENT_REQUEST_APPROVED', adjustmentRequestId: id },
    );

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
        action: 'REJECT',
        resource: 'ADJUSTMENT_REQUEST',
        resourceId: id,
        details: {
          targetType: request.targetType,
          targetId: request.targetId,
          rejectionReason: rejectionReason.trim(),
        },
      },
    });

    await this.notifyBusiness(
      request.requesterBusinessId,
      'تم رفض طلب التعديل',
      `تم رفض طلب التعديل. السبب: ${rejectionReason.trim()}`,
      { type: 'ADJUSTMENT_REQUEST_REJECTED', adjustmentRequestId: id },
    );

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
