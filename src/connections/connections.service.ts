import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { ManualAddConnectionDto } from './dto/manual-add-connection.dto';
import { Decimal } from 'decimal.js';
import { PaginationDto } from '../common/dto/pagination.dto';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { FinanceService } from '../finance/finance.service';

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly eventsGateway: EventsGateway,
    private readonly financeService: FinanceService,
  ) {}

  private normalizeConnection(connection: any, businessId: string, includeLinks = true) {
    if (!connection) return null;
    const plainConnection = JSON.parse(JSON.stringify(connection));
    const isRequester = plainConnection.requesterId === businessId;
    
    let account = plainConnection.account;
    if (account) {
      const dbBalance = new Decimal(account.balance as any || 0);
      const normalizedBalance = isRequester ? dbBalance : dbBalance.negated();
      account = {
        ...account,
        balance: normalizedBalance.toNumber(),
        totalCredit: normalizedBalance.greaterThan(0) ? normalizedBalance.toNumber() : 0,
        totalDebit: normalizedBalance.lessThan(0) ? normalizedBalance.abs().toNumber() : 0,
      };
    }

    const result: any = {
      ...plainConnection,
      account,
      connectionType: isRequester
        ? plainConnection.connectionType
        : plainConnection.connectionType === 'CUSTOMER'
        ? 'SUPPLIER'
        : 'CUSTOMER',
      direction: isRequester ? 'SENT' : 'RECEIVED',
    };

    if (plainConnection.receiver || plainConnection.requester) {
      result.business = isRequester ? plainConnection.receiver : plainConnection.requester;
    }

    if (includeLinks) {
      let linkedConnection: any = null;
      let linkedConnectionId: string | null = null;
      
      const activeCustomerLink = plainConnection.customerLinks?.find(
        (l: any) => l.status === 'ACTIVE',
      );
      const activeSupplierLink = plainConnection.supplierLinks?.find(
        (l: any) => l.status === 'ACTIVE',
      );

      if (activeCustomerLink && activeCustomerLink.supplier) {
        linkedConnectionId = activeCustomerLink.supplierId;
        linkedConnection = this.normalizeConnection(
          activeCustomerLink.supplier,
          businessId,
          false,
        );
      } else if (activeSupplierLink && activeSupplierLink.customer) {
        linkedConnectionId = activeSupplierLink.customerId;
        linkedConnection = this.normalizeConnection(
          activeSupplierLink.customer,
          businessId,
          false,
        );
      }

      result.linkedConnectionId = linkedConnectionId;
      result.linkedConnection = linkedConnection;
      result.linkedConnectionLinkId = activeCustomerLink?.id || activeSupplierLink?.id || null;
    }

    return result;
  }

  async createConnection(businessId: string, userId: string, dto: CreateConnectionDto) {
    if (businessId === dto.receiverId) {
      throw new BadRequestException('لا يمكنك الارتباط بنفسك');
    }

    const receiver = await this.prisma.business.findUnique({
      where: { id: dto.receiverId },
      include: { user: true },
    });

    if (!receiver || !receiver.user.isActive) {
      throw new NotFoundException('الحساب المطلوب غير موجود أو غير نشط');
    }

    const requestedRole = dto.connectionType; // 'CUSTOMER' or 'SUPPLIER'
    const invertedRole = requestedRole === 'CUSTOMER' ? 'SUPPLIER' : 'CUSTOMER';

    const connection = await this.prisma.connection.findFirst({
      where: {
        OR: [
          { requesterId: businessId, receiverId: dto.receiverId, connectionType: requestedRole },
          { requesterId: dto.receiverId, receiverId: businessId, connectionType: invertedRole },
        ],
      },
    });

    let finalConnection: any;

    if (connection) {
      // 1. If currently accepted or pending, it's a conflict
      if (connection.status === 'ACCEPTED' || connection.status === 'PENDING') {
        const msg = requestedRole === 'CUSTOMER' ? 'هذا العميل موجود بالفعل' : 'هذا المورد موجود بالفعل';
        throw new ConflictException(msg);
      }

      // 2. If blocked, users must handle unblocking first
      if (connection.status === 'BLOCKED') {
        throw new BadRequestException('الارتباط محظور. يجب إلغاء الحظر أولاً');
      }

      // 3. If rejected, handle the retry logic with cooldown and limit
      if (connection.status === 'REJECTED') {
        if (connection.retryCount >= 3) {
          throw new BadRequestException(
            'لقد استنفدت الحد الأقصى لمحاولات الإرسال (3 محاولات)',
          );
        }

        const lastRequested = connection.lastRequestedAt
          ? new Date(connection.lastRequestedAt).getTime()
          : 0;
        const cooldownMs = 24 * 60 * 60 * 1000; // 24 hours
        const now = Date.now();

        if (now - lastRequested < cooldownMs) {
          const hoursLeft = Math.ceil(
            (cooldownMs - (now - lastRequested)) / (60 * 60 * 1000),
          );
          throw new BadRequestException(
            `يرجى الانتظار ${hoursLeft} ساعة قبل إعادة المحاولة`,
          );
        }

        // Reset to pending
        finalConnection = await this.prisma.connection.update({
          where: { id: connection.id },
          data: {
            status: 'PENDING',
            requesterId: businessId,
            receiverId: dto.receiverId,
            connectionType: dto.connectionType,
            retryCount: { increment: 1 },
            isReadReceiver: false,
            lastRequestedAt: new Date(),
          },
          include: {
            requester: true,
            receiver: { include: { user: true } },
          },
        });
      }
    } else {
      // 4. Create new connection if none exists
      finalConnection = await this.prisma.connection.create({
        data: {
          requesterId: businessId,
          receiverId: dto.receiverId,
          connectionType: dto.connectionType,
          isReadReceiver: false,
          lastRequestedAt: new Date(),
        },
        include: {
          requester: true,
          receiver: { include: { user: true } },
        },
      });
    }

    // 5. Audit Log
    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'CREATE_CONNECTION_REQUEST',
        resource: 'CONNECTION',
        resourceId: finalConnection.id,
        details: {
          oldStatus: connection ? connection.status : 'NONE',
          newStatus: 'PENDING',
          connectionType: dto.connectionType,
        },
      },
    });

    // 6. Send Notification (using inverted type so receiver sees correct relationship)
    const isSupplierRequest = dto.connectionType === 'CUSTOMER';
    const customerId = isSupplierRequest ? dto.receiverId : businessId;
    const supplierId = isSupplierRequest ? businessId : dto.receiverId;

    await this.notificationsService.sendPushNotification(
      finalConnection.receiver.user.id,
      'طلب ارتباط جديد',
      `يريد ${finalConnection.requester.name} الارتباط بحسابك.`,
      {
        type: 'connection_request',
        notificationType: 'connection_request',
        entityType: 'connection_request',
        entityId: finalConnection.id,
        route: `app://connection-request/${finalConnection.id}`,
        requestId: finalConnection.id,
        customerId,
        supplierId,
      },
    );

    this.eventsGateway.emitToBusiness(
      dto.receiverId,
      'NEW_CONNECTION_REQUEST',
      {
        id: finalConnection.id,
        requesterName: finalConnection.requester.name,
        connectionType: dto.connectionType === 'SUPPLIER' ? 'CUSTOMER' : 'SUPPLIER',
      },
    );

    return this.normalizeConnection(finalConnection, businessId);
  }

  async acceptConnection(
    businessId: string,
    userId: string,
    connectionId: string,
    options?: {
      creditLimit?: number;
      billingCycle?: string;
      dueDate?: string;
      openingBalance?: number;
      showPrices?: boolean;
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
    const dueDate = options?.dueDate ? new Date(options.dueDate) : null;
    const openingBalance = options?.openingBalance ?? 0;
    const showPrices = options?.showPrices ?? false;

    const isRequester = connection.requesterId === businessId;
    const dbOpeningBalance = isRequester ? openingBalance : -openingBalance;

    // Accept connection and auto-create a financial Account with credit config if it doesn't exist
    return this.prisma.$transaction(async (prisma) => {
      // Check if account already exists (from a previous Accepted state before blocking)
      const existingAccount = await prisma.account.findUnique({
        where: { connectionId },
      });

      const updated = await (prisma.connection as any).update({
        where: { id: connectionId },
        data: {
          status: 'ACCEPTED',
          account: existingAccount
            ? {
                update: {
                  creditLimit,
                  billingCycle,
                  dueDate,
                  ...(openingBalance !== 0 && {
                    balance: dbOpeningBalance,
                    totalCredit: dbOpeningBalance > 0 ? dbOpeningBalance : 0,
                    totalDebit:
                      dbOpeningBalance < 0 ? Math.abs(dbOpeningBalance) : 0,
                  }),
                },
              }
            : {
                create: {
                  balance: dbOpeningBalance,
                  totalCredit: dbOpeningBalance > 0 ? dbOpeningBalance : 0,
                  totalDebit: dbOpeningBalance < 0 ? Math.abs(dbOpeningBalance) : 0,
                  creditLimit,
                  billingCycle,
                  dueDate,
                },
              },
          showPrices,
        },
        include: {
          account: true,
          requester: { include: { user: true } },
          receiver: true,
          customerLinks: {
            where: { status: 'ACTIVE' },
            include: { supplier: { include: { requester: true, receiver: true } } },
          },
          supplierLinks: {
            where: { status: 'ACTIVE' },
            include: { customer: { include: { requester: true, receiver: true } } },
          },
        },
      });

      // If there's an opening balance, create an ADJUSTMENT transaction to document it
      if (openingBalance !== 0) {
        const senderId = dbOpeningBalance > 0 ? connection.requesterId : connection.receiverId;
        const receiverId = dbOpeningBalance > 0 ? connection.receiverId : connection.requesterId;
        const amount = Math.abs(dbOpeningBalance);

        await prisma.transaction.create({
          data: {
            transactionType: 'ADJUSTMENT',
            amount,
            senderId,
            receiverId,
            note: `رصيد افتتاحي: ${openingBalance}`,
          },
        });

        // Log the opening balance in audit
        await prisma.auditLog.create({
          data: {
            userId,
            businessId,
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

      // Log connection accept in audit
      await prisma.auditLog.create({
        data: {
          userId,
          businessId,
          action: 'ACCEPT_CONNECTION_REQUEST',
          resource: 'CONNECTION',
          resourceId: connectionId,
          details: {
            oldStatus: 'PENDING',
            newStatus: 'ACCEPTED',
          },
        },
      });

      // Notify the requester
      await this.notificationsService.sendPushNotification(
        updated.requester.user.id,
        'تم قبول طلب الارتباط',
        `لقد قبل ${updated.receiver.name} طلب الارتباط الخاص بك.`,
        {
          type: 'connection_approved',
          notificationType: 'connection_approved',
          entityType: 'connection_request',
          entityId: updated.id,
          route: `app://connection-request/${updated.id}`,
          requestId: updated.id,
          supplierId: businessId,
        },
      );

      this.eventsGateway.emitToBusiness(
        updated.requesterId,
        'CONNECTION_ACCEPTED',
        {
          id: updated.id,
          receiverName: updated.receiver.name,
        },
      );

      return this.normalizeConnection(updated, businessId);
    });
  }

  async rejectConnection(businessId: string, userId: string, connectionId: string) {
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

    const updated = await this.prisma.connection.update({
      where: { id: connectionId },
      data: {
        status: 'REJECTED',
      },
      include: {
        requester: { include: { user: true } },
        receiver: true,
      },
    });

    // Log rejection in audit
    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'REJECT_CONNECTION_REQUEST',
        resource: 'CONNECTION',
        resourceId: connectionId,
        details: {
          oldStatus: 'PENDING',
          newStatus: 'REJECTED',
        },
      },
    });

    // Notify the requester
    await this.notificationsService.sendPushNotification(
      updated.requester.user.id,
      'تم رفض طلب الارتباط',
      `لقد تم رفض طلب الارتباط من قبل ${updated.receiver.name}.`,
      {
        type: 'connection_rejected',
        notificationType: 'connection_rejected',
        entityType: 'connection_request',
        entityId: updated.id,
        route: `app://connection-request/${updated.id}`,
        requestId: updated.id,
      },
    );

    this.eventsGateway.emitToBusiness(
      updated.requesterId,
      'CONNECTION_REJECTED',
      {
        id: updated.id,
        receiverName: updated.receiver.name,
      },
    );

    return this.normalizeConnection(updated, businessId);
  }

  async getConnections(
    businessId: string,
    pagination: PaginationDto,
    search?: string,
  ) {
    const { page = 1, limit = 10 } = pagination;
    const where: any = {
      OR: [{ requesterId: businessId }, { receiverId: businessId }],
    };

    if (search) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.trim());
      where.AND = [
        {
          OR: [
            ...(isUuid ? [
              { id: { equals: search.trim() } },
              { requesterId: { equals: search.trim() } },
              { receiverId: { equals: search.trim() } },
            ] : []),
            { requester: { name: { contains: search, mode: 'insensitive' } } },
            { receiver: { name: { contains: search, mode: 'insensitive' } } },
            { requester: { phoneNumber: { contains: search } } },
            { receiver: { phoneNumber: { contains: search } } },
            { requester: { user: { fullName: { contains: search, mode: 'insensitive' } } } },
            { receiver: { user: { fullName: { contains: search, mode: 'insensitive' } } } },
          ],
        },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.connection.findMany({
        where,
        include: {
          requester: {
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  userType: true,
                  isActive: true,
                },
              },
            },
          },
          receiver: {
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  userType: true,
                  isActive: true,
                },
              },
            },
          },
          account: true,
          customerLinks: {
            where: { status: 'ACTIVE' },
            include: { supplier: { include: { requester: true, receiver: true } } },
          },
          supplierLinks: {
            where: { status: 'ACTIVE' },
            include: { customer: { include: { requester: true, receiver: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.connection.count({ where }),
    ]);

    const normalizedData = data.map((connection) =>
      this.normalizeConnection(connection, businessId),
    );

    return {
      data: normalizedData,
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

    if (
      connection.requesterId !== businessId &&
      connection.receiverId !== businessId
    ) {
      throw new BadRequestException('ليس لديك صلاحية على هذا الارتباط');
    }

    const updated = await this.prisma.connection.update({
      where: { id: connectionId },
      data: {
        status: 'BLOCKED',
        blockedById: businessId, // Record who blocked it
      },
      include: {
        requester: true,
        receiver: true,
      },
    });

    return this.normalizeConnection(updated, businessId);
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
    const updated = await this.prisma.connection.update({
      where: { id: connectionId },
      data: {
        status: 'PENDING',
        blockedById: null,
      },
      include: {
        requester: true,
        receiver: true,
      },
    });

    return this.normalizeConnection(updated, businessId);
  }

  async toggleShowPrices(
    businessId: string,
    connectionId: string,
    show: boolean,
  ) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new NotFoundException('الارتباط غير موجود');
    }

    if (
      connection.requesterId !== businessId &&
      connection.receiverId !== businessId
    ) {
      throw new ForbiddenException('ليس لديك صلاحية على هذا الارتباط');
    }

    const updated = await (this.prisma.connection as any).update({
      where: { id: connectionId },
      data: { showPrices: show },
      include: {
        requester: true,
        receiver: true,
      },
    });

    return this.normalizeConnection(updated, businessId);
  }
  async manualAddConnection(myBusinessId: string, dto: ManualAddConnectionDto) {
    const {
      phoneNumber,
      name,
      businessName,
      email,
      connectionType = 'CUSTOMER',
      creditLimit,
      billingCycle,
      dueDate,
      openingBalance,
      showPrices,
    } = dto;

    let targetBusiness = await this.prisma.business.findFirst({
      where: { phoneNumber: phoneNumber },
    });

    if (!targetBusiness) {
      let targetUser = await this.prisma.user.findUnique({
        where: { phoneNumber: phoneNumber },
      });

      if (!targetUser) {
        const shadowPassword = await bcrypt.hash(
          randomBytes(32).toString('hex'),
          10,
        );
        targetUser = await this.prisma.user.create({
          data: {
            phoneNumber: phoneNumber,
            fullName: name,
            email:
              email ||
              `shadow_${phoneNumber}_${randomBytes(4).toString('hex')}@local.invalid`,
            password: shadowPassword,
            userType: 'individual',
            isActive: false,
          },
        });
      }

      targetBusiness = await this.prisma.business.create({
        data: {
          name: businessName || name,
          phoneNumber: phoneNumber,
          email,
          userId: targetUser.id,
          businessType: 'Shadow',
        },
      });
    }

    const requestedRole = connectionType || 'CUSTOMER';
    const invertedRole = requestedRole === 'CUSTOMER' ? 'SUPPLIER' : 'CUSTOMER';

    const existing = await this.prisma.connection.findFirst({
      where: {
        OR: [
          { requesterId: myBusinessId, receiverId: targetBusiness.id, connectionType: requestedRole },
          { requesterId: targetBusiness.id, receiverId: myBusinessId, connectionType: invertedRole },
        ],
      },
    });

    if (existing && existing.status === 'ACCEPTED') {
      const msg = requestedRole === 'CUSTOMER' ? 'هذا العميل موجود بالفعل' : 'هذا المورد موجود بالفعل';
      throw new ConflictException(msg);
    }

    if (existing) {
      const isRequester = existing.requesterId === myBusinessId;
      const dbConnectionType = isRequester
        ? connectionType
        : connectionType === 'CUSTOMER'
        ? 'SUPPLIER'
        : 'CUSTOMER';

      const updated = await this.prisma.connection.update({
        where: { id: existing.id },
        data: {
          status: 'ACCEPTED',
          connectionType: dbConnectionType,
          account: {
            upsert: {
              create: { balance: 0, creditLimit: 100000 },
              update: {
                ...(creditLimit !== undefined && { creditLimit }),
                ...(billingCycle !== undefined && { billingCycle }),
                ...(dueDate !== undefined && {
                  dueDate: dueDate ? new Date(dueDate) : null,
                }),
              },
            },
          },
          ...(showPrices !== undefined && { showPrices }),
        },
        include: {
          requester: true,
          receiver: true,
        },
      });
      return this.normalizeConnection(updated, myBusinessId);
    }

    const initialBalance = Number(openingBalance ?? 0);
    const accountCreditLimit = Number(creditLimit ?? 100000);

    const created = await this.prisma.connection.create({
      data: {
        requesterId: myBusinessId,
        receiverId: targetBusiness.id,
        status: 'ACCEPTED',
        connectionType: connectionType,
        showPrices: showPrices ?? false,
        account: {
          create: {
            balance: initialBalance,
            totalCredit: initialBalance > 0 ? initialBalance : 0,
            totalDebit: initialBalance < 0 ? Math.abs(initialBalance) : 0,
            creditLimit: accountCreditLimit,
            billingCycle,
            dueDate: dueDate ? new Date(dueDate) : undefined,
          },
        },
      },
      include: {
        requester: true,
        receiver: true,
      },
    });

    if (initialBalance !== 0) {
      const senderId = initialBalance > 0 ? created.requesterId : created.receiverId;
      const receiverId = initialBalance > 0 ? created.receiverId : created.requesterId;
      const amount = Math.abs(initialBalance);

      await this.prisma.transaction.create({
        data: {
          transactionType: 'ADJUSTMENT',
          amount,
          senderId,
          receiverId,
          note: `رصيد افتتاحي: ${initialBalance}`,
        },
      });
    }

    return this.normalizeConnection(created, myBusinessId);
  }

  async updateAccountTerms(
    businessId: string,
    connectionId: string,
    terms: {
      creditLimit?: number;
      billingCycle?: string;
      dueDate?: string | null;
      openingBalance?: number;
    },
  ) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      include: { account: true },
    });

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (
      connection.requesterId !== businessId &&
      connection.receiverId !== businessId
    ) {
      throw new ForbiddenException('You do not have access to this connection');
    }

    if (connection.status !== 'ACCEPTED' || !connection.account) {
      throw new BadRequestException(
        'Accepted connection with account is required',
      );
    }

    if (terms.creditLimit !== undefined && terms.creditLimit < 0) {
      throw new BadRequestException('Credit limit must be zero or greater');
    }

    const account = connection.account;
    const isRequester = connection.requesterId === businessId;

    return this.prisma.$transaction(async (tx) => {
      let dbOpeningBalance = terms.openingBalance;
      if (dbOpeningBalance !== undefined) {
        dbOpeningBalance = isRequester ? dbOpeningBalance : -dbOpeningBalance;
      }

      const updated = await tx.account.update({
        where: { id: account.id },
        data: {
          ...(terms.creditLimit !== undefined && {
            creditLimit: terms.creditLimit,
          }),
          ...(terms.billingCycle !== undefined && {
            billingCycle: terms.billingCycle,
          }),
          ...(terms.dueDate !== undefined && {
            dueDate: terms.dueDate ? new Date(terms.dueDate) : null,
          }),
        },
      });

      if (dbOpeningBalance !== undefined) {
        // Find existing opening balance transaction
        const existingAdjustment = await tx.transaction.findFirst({
          where: {
            transactionType: 'ADJUSTMENT',
            note: { startsWith: 'رصيد افتتاحي' },
            OR: [
              { senderId: connection.requesterId, receiverId: connection.receiverId },
              { senderId: connection.receiverId, receiverId: connection.requesterId },
            ],
          },
        });

        if (dbOpeningBalance === 0) {
          if (existingAdjustment) {
            await tx.transaction.delete({ where: { id: existingAdjustment.id } });
          }
        } else {
          const senderId = dbOpeningBalance > 0 ? connection.requesterId : connection.receiverId;
          const receiverId = dbOpeningBalance > 0 ? connection.receiverId : connection.requesterId;
          const amount = Math.abs(dbOpeningBalance);

          if (existingAdjustment) {
            await tx.transaction.update({
              where: { id: existingAdjustment.id },
              data: {
                amount,
                senderId,
                receiverId,
                note: `رصيد افتتاحي: ${terms.openingBalance}`,
              },
            });
          } else {
            await tx.transaction.create({
              data: {
                transactionType: 'ADJUSTMENT',
                amount,
                senderId,
                receiverId,
                note: `رصيد افتتاحي: ${terms.openingBalance}`,
              },
            });
          }
        }
        await this.financeService.rebuildAccountBalance(account.id, tx);
      }

      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          resource: 'ACCOUNT_TERMS',
          resourceId: updated.id,
          businessId,
          details: terms,
        },
      });

      // Return the fresh account state (fully rebuilt) from DB
      return tx.account.findUnique({
        where: { id: account.id },
      });
    });
  }

  async updateContactInfo(
    myBusinessId: string,
    connectionId: string,
    dto: {
      phoneNumber?: string;
      ownerName?: string;
      notes?: string;
    },
  ) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      include: {
        requester: { include: { user: true } },
        receiver: { include: { user: true } },
      },
    });

    if (!connection) {
      throw new NotFoundException('الارتباط غير موجود');
    }

    if (
      connection.requesterId !== myBusinessId &&
      connection.receiverId !== myBusinessId
    ) {
      throw new ForbiddenException('ليس لديك صلاحية على هذا الارتباط');
    }

    const isRequester = connection.requesterId === myBusinessId;
    const targetBusiness = isRequester ? connection.receiver : connection.requester;

    // Update connection notes
    const connectionUpdateData: any = {};
    if (dto.notes !== undefined) {
      connectionUpdateData.notes = dto.notes;
    }
    await this.prisma.connection.update({
      where: { id: connectionId },
      data: connectionUpdateData,
    });

    // If target business is a Shadow/manual business, we can update its phone number and user ownerName
    if (targetBusiness && (targetBusiness.businessType === 'Shadow' || (targetBusiness.user && !targetBusiness.user.isActive))) {
      const businessUpdateData: any = {};
      if (dto.phoneNumber) {
        businessUpdateData.phoneNumber = dto.phoneNumber;
      }
      await this.prisma.business.update({
        where: { id: targetBusiness.id },
        data: businessUpdateData,
      });

      if (targetBusiness.user) {
        const userUpdateData: any = {};
        if (dto.phoneNumber) {
          userUpdateData.phoneNumber = dto.phoneNumber;
        }
        if (dto.ownerName) {
          userUpdateData.fullName = dto.ownerName;
        }
        await this.prisma.user.update({
          where: { id: targetBusiness.user.id },
          data: userUpdateData,
        });
      }
    }

    const finalConnection = await this.prisma.connection.findFirst({
      where: { id: connectionId },
      include: {
        requester: { include: { user: true } },
        receiver: { include: { user: true } },
        account: true,
      },
    });

    return this.normalizeConnection(finalConnection, myBusinessId);
  }

  async getConnectionRequests(
    businessId: string,
    query: {
      status?: string;
      search?: string;
      startDate?: string;
      endDate?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const status = query.status;
    const search = query.search;
    const startDate = query.startDate;
    const endDate = query.endDate;
    const page = Number(query.page || 1);
    const limit = Number(query.limit || 10);

    const where: any = {
      OR: [{ requesterId: businessId }, { receiverId: businessId }],
    };

    if (status) {
      where.status = status;
    }

    if (search) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.trim());
      where.AND = [
        {
          OR: [
            ...(isUuid ? [
              { id: { equals: search.trim() } },
            ] : []),
            { requester: { name: { contains: search, mode: 'insensitive' } } },
            { receiver: { name: { contains: search, mode: 'insensitive' } } },
            { requester: { phoneNumber: { contains: search } } },
            { receiver: { phoneNumber: { contains: search } } },
          ],
        },
      ];
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        where.createdAt.gte = new Date(startDate);
      }
      if (endDate) {
        where.createdAt.lte = new Date(endDate);
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.connection.findMany({
        where,
        include: {
          requester: {
            include: {
              user: {
                select: { id: true, fullName: true, userType: true, isActive: true },
              },
            },
          },
          receiver: {
            include: {
              user: {
                select: { id: true, fullName: true, userType: true, isActive: true },
              },
            },
          },
          account: true,
          customerLinks: {
            where: { status: 'ACTIVE' },
            include: { supplier: { include: { requester: true, receiver: true } } },
          },
          supplierLinks: {
            where: { status: 'ACTIVE' },
            include: { customer: { include: { requester: true, receiver: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.connection.count({ where }),
    ]);

    const normalizedData = data.map((item) => this.normalizeConnection(item, businessId));

    return {
      data: normalizedData,
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
        limit,
      },
    };
  }

  async getConnectionRequestsStats(businessId: string) {
    const [pending, incomingPending, outgoingPending, unreadPending] = await Promise.all([
      this.prisma.connection.count({
        where: {
          status: 'PENDING',
          OR: [{ requesterId: businessId }, { receiverId: businessId }],
        },
      }),
      this.prisma.connection.count({
        where: {
          status: 'PENDING',
          receiverId: businessId,
        },
      }),
      this.prisma.connection.count({
        where: {
          status: 'PENDING',
          requesterId: businessId,
        },
      }),
      this.prisma.connection.count({
        where: {
          status: 'PENDING',
          receiverId: businessId,
          isReadReceiver: false,
        },
      }),
    ]);

    return {
      pending,
      incomingPending,
      outgoingPending,
      unreadPending,
    };
  }

  async markConnectionRequestsAsRead(businessId: string) {
    const result = await this.prisma.connection.updateMany({
      where: {
        receiverId: businessId,
        status: 'PENDING',
        isReadReceiver: false,
      },
      data: {
        isReadReceiver: true,
      },
    });

    return { count: result.count };
  }

  async getConnectionRequestDetails(businessId: string, userId: string, id: string) {
    const connection = await this.prisma.connection.findUnique({
      where: { id },
      include: {
        requester: {
          include: {
            user: {
              select: { id: true, fullName: true, userType: true, isActive: true },
            },
          },
        },
        receiver: {
          include: {
            user: {
              select: { id: true, fullName: true, userType: true, isActive: true },
            },
          },
        },
        account: true,
        customerLinks: {
          where: { status: 'ACTIVE' },
          include: { supplier: { include: { requester: true, receiver: true } } },
        },
        supplierLinks: {
          where: { status: 'ACTIVE' },
          include: { customer: { include: { requester: true, receiver: true } } },
        },
      },
    });

    if (!connection) {
      throw new NotFoundException('الارتباط غير موجود');
    }

    if (
      connection.requesterId !== businessId &&
      connection.receiverId !== businessId
    ) {
      throw new ForbiddenException('ليس لديك صلاحية على هذا الارتباط');
    }

    // Mark as read if the recipient views it
    if (connection.receiverId === businessId && !connection.isReadReceiver) {
      await this.prisma.connection.update({
        where: { id },
        data: { isReadReceiver: true },
      });
      connection.isReadReceiver = true;
    }

    // Create audit log for view request
    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'VIEW_CONNECTION_REQUEST',
        resource: 'CONNECTION',
        resourceId: id,
        details: {
          status: connection.status,
          timestamp: new Date().toISOString(),
        },
      },
    });

    return this.normalizeConnection(connection, businessId);
  }

  async getConnectionRequestAudit(businessId: string, id: string) {
    const connection = await this.prisma.connection.findUnique({
      where: { id },
    });

    if (!connection) {
      throw new NotFoundException('الارتباط غير موجود');
    }

    if (
      connection.requesterId !== businessId &&
      connection.receiverId !== businessId
    ) {
      throw new ForbiddenException('ليس لديك صلاحية على هذا الارتباط');
    }

    return this.prisma.auditLog.findMany({
      where: {
        resource: 'CONNECTION',
        resourceId: id,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async cancelConnection(businessId: string, userId: string, connectionId: string) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new NotFoundException('الارتباط غير موجود');
    }

    if (connection.requesterId !== businessId) {
      throw new BadRequestException('فقط مرسل الطلب يمكنه إلغاء الارتباط');
    }

    if (connection.status !== 'PENDING') {
      throw new BadRequestException(`الارتباط بالفعل ${connection.status}`);
    }

    const updated = await this.prisma.connection.update({
      where: { id: connectionId },
      data: { status: 'CANCELLED' },
      include: {
        requester: { include: { user: true } },
        receiver: true,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'CANCEL_CONNECTION_REQUEST',
        resource: 'CONNECTION',
        resourceId: connectionId,
        details: { oldStatus: 'PENDING', newStatus: 'CANCELLED' },
      },
    });

    return this.normalizeConnection(updated, businessId);
  }

  async linkConnections(
    businessId: string,
    userId: string,
    dto: { customerId: string; supplierId: string }
  ) {
    const [customerConn, supplierConn] = await Promise.all([
      this.prisma.connection.findUnique({
        where: { id: dto.customerId },
        include: {
          customerLinks: { where: { status: 'ACTIVE' } },
          supplierLinks: { where: { status: 'ACTIVE' } }
        }
      }),
      this.prisma.connection.findUnique({
        where: { id: dto.supplierId },
        include: {
          customerLinks: { where: { status: 'ACTIVE' } },
          supplierLinks: { where: { status: 'ACTIVE' } }
        }
      }),
    ]);

    if (!customerConn || !supplierConn) {
      throw new NotFoundException('أحد الارتباطات غير موجود');
    }

    // Verify ownership
    if (
      (customerConn.requesterId !== businessId && customerConn.receiverId !== businessId) ||
      (supplierConn.requesterId !== businessId && supplierConn.receiverId !== businessId)
    ) {
      throw new ForbiddenException('ليس لديك صلاحية على أحد الارتباطات');
    }

    // Verify counterparty is the same
    const customerOther = customerConn.requesterId === businessId ? customerConn.receiverId : customerConn.requesterId;
    const supplierOther = supplierConn.requesterId === businessId ? supplierConn.receiverId : supplierConn.requesterId;

    if (customerOther !== supplierOther) {
      throw new BadRequestException('يجب أن يكون العميل والمورد لنفس الشركة/الطرف الثاني');
    }

    // Check if already linked
    const isCustomerLinked = customerConn.customerLinks.length > 0 || customerConn.supplierLinks.length > 0;
    const isSupplierLinked = supplierConn.customerLinks.length > 0 || supplierConn.supplierLinks.length > 0;

    if (isCustomerLinked || isSupplierLinked) {
      throw new BadRequestException('أحد السجلات مرتبط بالفعل بحساب آخر');
    }

    const link = await this.prisma.customerSupplierLink.create({
      data: {
        customerId: dto.customerId,
        supplierId: dto.supplierId,
        createdById: userId,
        status: 'ACTIVE',
      },
    });

    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'LINK_CREATED',
        resource: 'CONNECTION',
        resourceId: dto.customerId,
        details: {
          customerId: dto.customerId,
          supplierId: dto.supplierId,
          linkId: link.id,
        },
      },
    });

    return link;
  }

  async unlinkConnections(businessId: string, userId: string, linkId: string) {
    const link = await this.prisma.customerSupplierLink.findUnique({
      where: { id: linkId },
    });

    if (!link) {
      throw new NotFoundException('رابط الارتباط غير موجود');
    }

    // Delete link
    await this.prisma.customerSupplierLink.delete({
      where: { id: linkId },
    });

    await this.prisma.auditLog.create({
      data: {
        userId,
        businessId,
        action: 'LINK_REMOVED',
        resource: 'CONNECTION',
        resourceId: link.customerId,
        details: {
          customerId: link.customerId,
          supplierId: link.supplierId,
          linkId: link.id,
        },
      },
    });

    return { success: true };
  }

  async getLinkableConnections(businessId: string, connectionId: string) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new NotFoundException('الارتباط غير موجود');
    }

    const otherPartyId = connection.requesterId === businessId ? connection.receiverId : connection.requesterId;

    // Check if this connection is a Customer or Supplier from our perspective
    const isCustomer = (connection.requesterId === businessId && connection.connectionType === 'CUSTOMER') ||
                       (connection.receiverId === businessId && connection.connectionType === 'SUPPLIER');

    const oppositeType = isCustomer ? 'SUPPLIER' : 'CUSTOMER';

    // Find connections with the same otherPartyId that are of the opposite type
    // and not already linked
    const candidates = await this.prisma.connection.findMany({
      where: {
        OR: [
          { requesterId: businessId, receiverId: otherPartyId, connectionType: oppositeType },
          { requesterId: otherPartyId, receiverId: businessId, connectionType: isCustomer ? 'CUSTOMER' : 'SUPPLIER' },
        ],
        status: 'ACCEPTED',
      },
      include: {
        requester: true,
        receiver: true,
        customerLinks: true,
        supplierLinks: true,
      },
    });

    // Filter out already linked candidates
    const filtered = candidates.filter(c => {
      const isLinked = c.customerLinks.some(l => l.status === 'ACTIVE') ||
                       c.supplierLinks.some(l => l.status === 'ACTIVE');
      return !isLinked;
    });

    return filtered.map(c => this.normalizeConnection(c, businessId));
  }
}

