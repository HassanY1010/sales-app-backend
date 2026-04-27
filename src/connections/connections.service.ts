import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { Decimal } from 'decimal.js';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class ConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async createConnection(businessId: string, dto: CreateConnectionDto) {
    if (businessId === dto.receiverId) {
      throw new BadRequestException('لا يمكنك الارتباط بنفسك');
    }

    const connection = await this.prisma.connection.findFirst({
      where: {
        OR: [
          { requesterId: businessId, receiverId: dto.receiverId },
          { requesterId: dto.receiverId, receiverId: businessId },
        ],
      },
    });

    if (connection) {
      // 1. If currently accepted or pending, it's a conflict
      if (connection.status === 'ACCEPTED' || connection.status === 'PENDING') {
        throw new ConflictException(`الارتباط موجود بالفعل أو قيد الانتظار (${connection.status})`);
      }

      // 2. If blocked, users must handle unblocking first
      if (connection.status === 'BLOCKED') {
        throw new BadRequestException('الارتباط محظور. يجب إلغاء الحظر أولاً');
      }

      // 3. If rejected, handle the retry logic with cooldown and limit
      if (connection.status === 'REJECTED') {
        if (connection.retryCount >= 3) {
          throw new BadRequestException('لقد استنفدت الحد الأقصى لمحاولات الإرسال (3 محاولات)');
        }

        const lastRequested = connection.lastRequestedAt ? new Date(connection.lastRequestedAt).getTime() : 0;
        const cooldownMs = 24 * 60 * 60 * 1000; // 24 hours
        const now = Date.now();

        if (now - lastRequested < cooldownMs) {
          const hoursLeft = Math.ceil((cooldownMs - (now - lastRequested)) / (60 * 60 * 1000));
          throw new BadRequestException(`يرجى الانتظار ${hoursLeft} ساعة قبل إعادة المحاولة`);
        }

        // Reset to pending
        return this.prisma.connection.update({
          where: { id: connection.id },
          data: {
            status: 'PENDING',
            requesterId: businessId, // Ensure the new requester is current user
            receiverId: dto.receiverId,
            retryCount: { increment: 1 },
            lastRequestedAt: new Date(),
          },
        });
      }
    }

    // 4. Create new connection if none exists
    return this.prisma.connection.create({
      data: {
        requesterId: businessId,
        receiverId: dto.receiverId,
        connectionType: dto.connectionType,
        lastRequestedAt: new Date(),
      },
    });
  }

  async acceptConnection(
    businessId: string,
    connectionId: string,
    options?: {
      creditLimit?: number;
      billingCycle?: string;
      openingBalance?: number;
    },
  ) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new NotFoundException('الارتباط غير موجود');
    }

    if (connection.receiverId !== businessId) {
      throw new BadRequestException('فقط المستقبل يمكنه قبول الارتباط');
    }

    if (connection.status !== 'PENDING') {
      throw new BadRequestException(`الارتباط بالفعل ${connection.status}`);
    }

    const creditLimit = options?.creditLimit ?? 100000;
    const billingCycle = options?.billingCycle ?? null;
    const openingBalance = options?.openingBalance ?? 0;

    // Accept connection and auto-create a financial Account with credit config if it doesn't exist
    return this.prisma.$transaction(async (prisma) => {
      // Check if account already exists (from a previous Accepted state before blocking)
      const existingAccount = await prisma.account.findUnique({
        where: { connectionId },
      });

      const updated = await prisma.connection.update({
        where: { id: connectionId },
        data: {
          status: 'ACCEPTED',
          account: !existingAccount ? {
            create: {
              balance: openingBalance,
              totalCredit: openingBalance > 0 ? openingBalance : 0,
              totalDebit: openingBalance < 0 ? Math.abs(openingBalance) : 0,
              creditLimit,
              billingCycle,
            },
          } : undefined, // If account already exists, we just update status to ACCEPTED
        },
        include: {
          account: true,
          requester: true,
          receiver: true,
        },
      });

      // If there's an opening balance, create an ADJUSTMENT transaction to document it
      if (openingBalance !== 0) {
        await prisma.transaction.create({
          data: {
            transactionType: 'ADJUSTMENT',
            amount: Math.abs(openingBalance),
            senderId: connection.requesterId,
            receiverId: connection.receiverId,
            note: `رصيد افتتاحي: ${openingBalance}`,
          },
        });

        // Log the opening balance in audit
        await prisma.auditLog.create({
          data: {
            action: 'CREATE',
            resource: 'ACCOUNT',
            resourceId: updated.account!.id,
            details: {
              type: 'OPENING_BALANCE',
              openingBalance,
              creditLimit,
              billingCycle,
            },
          },
        });
      }

      return updated;
    });
  }

  async rejectConnection(businessId: string, connectionId: string) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new NotFoundException('الارتباط غير موجود');
    }

    if (connection.receiverId !== businessId) {
      throw new BadRequestException('فقط المستقبل يمكنه رفض الارتباط');
    }

    if (connection.status !== 'PENDING') {
      throw new BadRequestException(`الارتباط بالفعل ${connection.status}`);
    }

    return this.prisma.connection.update({
      where: { id: connectionId },
      data: {
        status: 'REJECTED',
      },
    });
  }

  async getConnections(businessId: string, pagination: PaginationDto, search?: string) {
    const { page = 1, limit = 10 } = pagination;
    const where: any = {
      OR: [
        { requesterId: businessId },
        { receiverId: businessId },
      ],
    };

    if (search) {
      where.AND = [
        {
          OR: [
            { requester: { name: { contains: search } } },
            { receiver: { name: { contains: search } } },
            { requester: { phoneNumber: { contains: search } } },
            { receiver: { phoneNumber: { contains: search } } },
          ],
        },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.connection.findMany({
        where,
        include: {
          requester: true,
          receiver: true,
          account: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.connection.count({ where }),
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

  async blockConnection(businessId: string, connectionId: string) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new NotFoundException('الارتباط غير موجود');
    }

    if (connection.requesterId !== businessId && connection.receiverId !== businessId) {
      throw new BadRequestException('ليس لديك صلاحية على هذا الارتباط');
    }

    return this.prisma.connection.update({
      where: { id: connectionId },
      data: { 
        status: 'BLOCKED',
        blockedById: businessId, // Record who blocked it
      },
    });
  }

  async unblockConnection(businessId: string, connectionId: string) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new NotFoundException('الارتباط غير موجود');
    }

    if (connection.status !== 'BLOCKED') {
      throw new BadRequestException('هذا الارتباط غير محظور أصلاً');
    }

    if (connection.blockedById !== businessId) {
      throw new ForbiddenException('فقط الطرف الذي قام بالحظر يمكنه فك الحظر');
    }

    // Unblocking moves connection back to PENDING as per user requirement
    // This requires the other party to re-accept explicitly.
    return this.prisma.connection.update({
      where: { id: connectionId },
      data: { 
        status: 'PENDING',
        blockedById: null,
      },
    });
  }
}

