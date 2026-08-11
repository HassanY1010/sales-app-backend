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
import { SendRelationshipRequestDto } from './dto/send-relationship-request.dto';
import { Decimal } from 'decimal.js';
import { PaginationDto } from '../common/dto/pagination.dto';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { FinanceService } from '../finance/finance.service';

import { Logger } from '@nestjs/common';

@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly eventsGateway: EventsGateway,
    private readonly financeService: FinanceService,
  ) {}

  /**
   * Universal phone number normalizer.
   * Strips non-digits, leading country code (+967, 00967, 967) and leading zero.
   * Ensures '+967777123456', '967777123456', '0777123456', and '777123456'
   * all normalize to the exact same string '777123456'.
   */
  public normalizePhoneNumber(phone: string): string {
    if (!phone) return '';
    let digits = phone.trim().replace(/\D/g, '');
    if (digits.startsWith('00')) {
      digits = digits.substring(2);
    }
    if (digits.startsWith('967')) {
      digits = digits.substring(3);
    }
    if (digits.startsWith('0')) {
      digits = digits.substring(1);
    }
    return digits;
  }

  private normalizeConnection(connection: any, businessId: string, includeLinks = true) {
    if (!connection) return null;
    const plainConnection = JSON.parse(JSON.stringify(connection));
    const isRequester = plainConnection.requesterId === businessId;
    const rawConnType = (plainConnection.connectionType || '').toUpperCase();
    const rawReqSource = (plainConnection.requestSource || '').toUpperCase();

    const requestSource = rawReqSource || (rawConnType === 'CUSTOMER' ? 'CUSTOMERS' : 'SUPPLIERS');
    const effectiveType = isRequester
      ? (requestSource === 'CUSTOMERS' ? 'CUSTOMER' : 'SUPPLIER')
      : (requestSource === 'CUSTOMERS' ? 'SUPPLIER' : 'CUSTOMER');
    
    let account = plainConnection.account;
    if (account) {
      const dbBalance = new Decimal(account.balance as any || 0);
      const numBalance = dbBalance.toNumber();
      const isCustomer = effectiveType === 'CUSTOMER';

      let totalDebit = 0;
      let totalCredit = 0;

      if (isCustomer) {
        // Customer: balance > 0 = عليه (totalDebit), balance < 0 = له (totalCredit)
        if (numBalance > 0) totalDebit = numBalance;
        if (numBalance < 0) totalCredit = Math.abs(numBalance);
      } else {
        // Supplier: balance > 0 = له (totalCredit), balance < 0 = عليه (totalDebit)
        if (numBalance > 0) totalCredit = numBalance;
        if (numBalance < 0) totalDebit = Math.abs(numBalance);
      }

      account = {
        ...account,
        balance: numBalance,
        totalDebit,
        totalCredit,
      };
    }

    const result: any = {
      ...plainConnection,
      account,
      connectionType: effectiveType,
      direction: isRequester ? 'SENT' : 'RECEIVED',
    };

    if (plainConnection.receiver || plainConnection.requester) {
      result.business = isRequester ? plainConnection.receiver : plainConnection.requester;
    }

    if (includeLinks) {
      let linkedConnection: any = null;
      let linkedConnectionId: string | null = null;
      
      const activeCustomerLink = plainConnection.customerLinks?.find(
        (l: any) => l.status === 'ACTIVE' || l.status === 'active',
      );
      const activeSupplierLink = plainConnection.supplierLinks?.find(
        (l: any) => l.status === 'ACTIVE' || l.status === 'active',
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
      const requestSource = dto.requestSource || (dto.connectionType === 'CUSTOMER' ? 'CUSTOMERS' : 'SUPPLIERS');
      const connectionType = requestSource === 'CUSTOMERS' ? 'CUSTOMER' : 'SUPPLIER';

      finalConnection = await this.prisma.connection.create({
        data: {
          requesterId: businessId,
          receiverId: dto.receiverId,
          connectionType,
          requestSource,
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

    const requestSource = finalConnection.requestSource || (dto.connectionType === 'CUSTOMER' ? 'CUSTOMERS' : 'SUPPLIERS');
    const receiverRoleText = requestSource === 'CUSTOMERS' ? 'مورد' : 'عميل';
    const isSupplierRequest = requestSource === 'CUSTOMERS';
    const customerId = isSupplierRequest ? dto.receiverId : businessId;
    const supplierId = isSupplierRequest ? businessId : dto.receiverId;

    await this.notificationsService.sendPushNotification(
      finalConnection.receiver.user.id,
      'طلب ارتباط جديد',
      `أرسل لك ${finalConnection.requester.name} طلب ارتباط كـ (${receiverRoleText}).`,
      {
        type: 'connection_request',
        notificationType: 'connection_request',
        entityType: 'connection_request',
        entityId: finalConnection.id,
        route: `app://connection-request/${finalConnection.id}`,
        requestId: finalConnection.id,
        requestSource,
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
        requestSource,
        connectionType: requestSource === 'CUSTOMERS' ? 'SUPPLIER' : 'CUSTOMER',
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

    // Enforce financial data when the request came from supplier screen
    if (connection.requiresReceiverInput) {
      if (options?.openingBalance === undefined || options?.openingBalance === null) {
        throw new BadRequestException('يجب إدخال الرصيد الافتتاحي لقبول هذا الطلب');
      }
      if (options?.creditLimit === undefined || options?.creditLimit === null) {
        throw new BadRequestException('يجب إدخال سقف المديونية لقبول هذا الطلب');
      }
    }

    // Use pending values as defaults when they exist (from customer screen requests)
    const creditLimit = options?.creditLimit ?? Number(connection.pendingCreditLimit ?? 100000);
    const billingCycle = options?.billingCycle ?? null;
    const dueDate = options?.dueDate ? new Date(options.dueDate) : null;
    const openingBalance = options?.openingBalance ?? Number(connection.pendingOpenBalance ?? 0);
    const showPrices = options?.showPrices ?? false;

    const isRequester = connection.requesterId === businessId;
    const dbOpeningBalance = isRequester ? openingBalance : -openingBalance;

    // Accept connection and auto-create a financial Account with credit config if it doesn't exist
    return this.prisma.$transaction(async (prisma) => {
      const currentConn = await prisma.connection.findUnique({
        where: { id: connectionId },
      });

      if (currentConn?.status === 'ACCEPTED') {
        throw new BadRequestException('هذا الطلب مقبول بالفعل');
      }

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
                },
              }
            : {
                create: {
                  balance: 0,
                  totalCredit: 0,
                  totalDebit: 0,
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

      // If there's an opening balance and no previous account balance, record the opening balance ONCE via FinanceService
      if (openingBalance !== 0 && (!existingAccount || new Decimal(existingAccount.balance as any || 0).isZero())) {
        await this.financeService.recordFinancialMovement(prisma, {
          senderId: connection.requesterId,
          receiverId: connection.receiverId!,
          amount: Math.abs(openingBalance),
          type: 'ADJUSTMENT',
          note: `رصيد افتتاحي: ${openingBalance}`,
          connectionId: connection.id,
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

      const freshConnection = await prisma.connection.findUnique({
        where: { id: connectionId },
        include: {
          account: true,
          requester: { include: { user: true } },
          receiver: { include: { user: true } },
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

      return this.normalizeConnection(freshConnection, businessId);
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
      `لقد تم رفض طلب الارتباط من قبل ${updated.receiver?.name ?? 'المستلم'}.`,
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
        receiverName: updated.receiver?.name ?? '',
      },
    );

    return this.normalizeConnection(updated, businessId);
  }

  async getConnections(
    businessId: string,
    pagination: PaginationDto,
    search?: string,
    type?: string,
  ) {
    const { page = 1, limit = 200 } = pagination;
    const upperType = type?.toUpperCase();

    // Base ownership filter: user must be requester or receiver
    let ownershipFilter: any = {
      OR: [{ requesterId: businessId }, { receiverId: businessId }],
    };

    // For CUSTOMER and SUPPLIER lists, only return accepted/active connections
    if (upperType === 'CUSTOMER' || upperType === 'SUPPLIER') {
      ownershipFilter = {
        AND: [
          {
            status: { in: ['ACCEPTED', 'accepted', 'ACTIVE', 'active'] },
          },
          {
            OR: [{ requesterId: businessId }, { receiverId: businessId }],
          },
        ],
      };
    }

    // Combine ownership filter with optional search
    let where: any;
    if (search) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.trim());
      const searchFilter = {
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
      };
      where = { AND: [ownershipFilter, searchFilter] };
    } else {
      where = ownershipFilter;
    }

    const data = await this.prisma.connection.findMany({
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
    });

    // 1. Normalize all connections using SSOT normalizeConnection
    const normalizedData = data
      .map((connection) => this.normalizeConnection(connection, businessId))
      .filter((conn) => conn != null);

    // 2. Filter by CUSTOMER / SUPPLIER role after normalization
    let filteredList = normalizedData;
    if (upperType === 'CUSTOMER') {
      filteredList = normalizedData.filter((c) => c.connectionType === 'CUSTOMER');
    } else if (upperType === 'SUPPLIER') {
      filteredList = normalizedData.filter((c) => c.connectionType === 'SUPPLIER');
    }

    const total = filteredList.length;
    const paginatedList = filteredList.slice((page - 1) * limit, page * limit);

    return {
      data: paginatedList,
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit) || 1,
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

    const requestSource = dto.requestSource || (connectionType === 'CUSTOMER' ? 'CUSTOMERS' : 'SUPPLIERS');
    const isCustomer = connectionType === 'CUSTOMER';
    let totalCredit = 0;
    let totalDebit = 0;

    if (isCustomer) {
      // Customer: balance > 0 = عليه (totalDebit), balance < 0 = له (totalCredit)
      if (initialBalance > 0) totalDebit = initialBalance;
      if (initialBalance < 0) totalCredit = Math.abs(initialBalance);
    } else {
      // Supplier: balance > 0 = له (totalCredit), balance < 0 = عليه (totalDebit)
      if (initialBalance > 0) totalCredit = initialBalance;
      if (initialBalance < 0) totalDebit = Math.abs(initialBalance);
    }

    const created = await this.prisma.connection.create({
      data: {
        requesterId: myBusinessId,
        receiverId: targetBusiness.id,
        status: 'ACCEPTED',
        connectionType: connectionType,
        requestSource,
        showPrices: showPrices ?? false,
        account: {
          create: {
            balance: initialBalance,
            totalCredit,
            totalDebit,
            creditLimit: accountCreditLimit,
            billingCycle,
            dueDate: dueDate ? new Date(dueDate) : undefined,
          },
        },
      },
      include: {
        requester: true,
        receiver: true,
        account: true,
      },
    });

    if (initialBalance !== 0) {
      await this.prisma.transaction.create({
        data: {
          transactionType: 'ADJUSTMENT',
          amount: Math.abs(initialBalance),
          senderId: myBusinessId,
          receiverId: targetBusiness.id,
          note: `رصيد افتتاحي: ${initialBalance}`,
        },
      });

      if (created.account?.id) {
        await this.financeService.rebuildAccountBalance(created.account.id);
      }
    }

    const freshConnection = await this.prisma.connection.findUnique({
      where: { id: created.id },
      include: {
        requester: true,
        receiver: true,
        account: true,
      },
    });

    return this.normalizeConnection(freshConnection, myBusinessId);
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
    if (!connection.receiverId) {
      throw new BadRequestException('الارتباط غير مكتمل (لا يوجد طرف مستلم)');
    }
    const receiverId = connection.receiverId;

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
              { senderId: connection.requesterId, receiverId: connection.receiverId! },
              { senderId: connection.receiverId!, receiverId: connection.requesterId },
            ],
          },
        });

        if (dbOpeningBalance === 0) {
          if (existingAdjustment) {
            await tx.transaction.delete({ where: { id: existingAdjustment.id } });
          }
        } else {
          const senderId = dbOpeningBalance > 0 ? connection.requesterId : receiverId;
          const targetReceiverId = dbOpeningBalance > 0 ? receiverId : connection.requesterId;
          const amount = Math.abs(dbOpeningBalance);

          if (existingAdjustment) {
            await tx.transaction.update({
              where: { id: existingAdjustment.id },
              data: {
                amount,
                senderId,
                receiverId: targetReceiverId,
                note: `رصيد افتتاحي: ${terms.openingBalance}`,
              },
            });
          } else {
            await tx.transaction.create({
              data: {
                transactionType: 'ADJUSTMENT',
                amount,
                senderId,
                receiverId: targetReceiverId,
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
    if (!otherPartyId) return [];

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
    const filtered = candidates.filter((c: any) => {
      const isLinked = (c.customerLinks || []).some((l: any) => l.status === 'ACTIVE') ||
                       (c.supplierLinks || []).some((l: any) => l.status === 'ACTIVE');
      return !isLinked;
    });

    return filtered.map((c: any) => this.normalizeConnection(c, businessId));
  }

  /**
   * Single Source of Truth: Resolves and validates an accepted connection between myBusinessId and targetIdentifier.
   * targetIdentifier can be a Connection.id, Business.id, User.id, CustomerSupplierLink.id, or Customer/Supplier ID.
   */
  async resolveAcceptedConnection(myBusinessId: string, targetIdentifier: string, expectedRole?: 'CUSTOMER' | 'SUPPLIER') {
    if (!myBusinessId || !targetIdentifier) return null;

    // 1. Direct search by Connection ID
    let connection = await this.prisma.connection.findFirst({
      where: {
        id: targetIdentifier,
        status: 'ACCEPTED',
        OR: [{ requesterId: myBusinessId }, { receiverId: myBusinessId }],
      },
      include: { account: true, requester: { include: { user: true } }, receiver: { include: { user: true } } },
    });

    if (connection) return connection;

    // 2. Search by Business ID
    connection = await this.prisma.connection.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: myBusinessId, receiverId: targetIdentifier },
          { requesterId: targetIdentifier, receiverId: myBusinessId },
        ],
        ...(expectedRole ? {
          OR: [
            { requesterId: myBusinessId, connectionType: expectedRole },
            { receiverId: myBusinessId, connectionType: expectedRole === 'CUSTOMER' ? 'SUPPLIER' : 'CUSTOMER' },
          ]
        } : {}),
      },
      include: { account: true, requester: { include: { user: true } }, receiver: { include: { user: true } } },
    });

    if (connection) return connection;

    // 3. Search by User ID
    const targetBusiness = await this.prisma.business.findFirst({
      where: { OR: [{ id: targetIdentifier }, { userId: targetIdentifier }] },
      select: { id: true },
    });

    if (targetBusiness?.id) {
      connection = await this.prisma.connection.findFirst({
        where: {
          status: 'ACCEPTED',
          OR: [
            { requesterId: myBusinessId, receiverId: targetBusiness.id },
            { requesterId: targetBusiness.id, receiverId: myBusinessId },
          ],
          ...(expectedRole ? {
            OR: [
              { requesterId: myBusinessId, connectionType: expectedRole },
              { receiverId: myBusinessId, connectionType: expectedRole === 'CUSTOMER' ? 'SUPPLIER' : 'CUSTOMER' },
            ]
          } : {}),
        },
        include: { account: true, requester: { include: { user: true } }, receiver: { include: { user: true } } },
      });

      if (connection) return connection;
    }

    // 4. Search by CustomerSupplierLink ID or linked dual account
    const link = await this.prisma.customerSupplierLink.findFirst({
      where: {
        OR: [{ id: targetIdentifier }, { customerId: targetIdentifier }, { supplierId: targetIdentifier }],
        status: 'ACTIVE',
      },
      include: {
        customer: { include: { account: true, requester: { include: { user: true } }, receiver: { include: { user: true } } } },
        supplier: { include: { account: true, requester: { include: { user: true } }, receiver: { include: { user: true } } } },
      },
    });

    if (link) {
      if (expectedRole === 'CUSTOMER' && link.customer.status === 'ACCEPTED') {
        return link.customer;
      }
      if (expectedRole === 'SUPPLIER' && link.supplier.status === 'ACCEPTED') {
        return link.supplier;
      }
      if (
        (link.customer.requesterId === myBusinessId || link.customer.receiverId === myBusinessId) &&
        link.customer.status === 'ACCEPTED'
      ) {
        return link.customer;
      }
      if (
        (link.supplier.requesterId === myBusinessId || link.supplier.receiverId === myBusinessId) &&
        link.supplier.status === 'ACCEPTED'
      ) {
        return link.supplier;
      }
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RELATIONSHIP REQUEST BY PHONE NUMBER
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a relationship request by phone number.
   * Handles both registered and unregistered receivers.
   * - Registered: creates a PENDING connection with receiverId
   * - Unregistered: creates a PENDING connection with receiverPhone + deferred data
   * Enforces the bidirectional role rule:
   *   - From customer screen: connectionType=CUSTOMER, requiresReceiverInput=false
   *   - From supplier screen: connectionType=SUPPLIER, requiresReceiverInput=true
   */
  async sendRelationshipRequestByPhone(
    businessId: string,
    userId: string,
    dto: SendRelationshipRequestDto,
  ) {
    if (!dto.phoneNumber) {
      throw new BadRequestException('رقم الهاتف مطلوب');
    }

    // Validate financial values
    if (dto.openingBalance !== undefined && isNaN(dto.openingBalance)) {
      throw new BadRequestException('الرصيد الافتتاحي غير صالح');
    }
    if (dto.creditLimit !== undefined && (isNaN(dto.creditLimit) || dto.creditLimit < 0)) {
      throw new BadRequestException('سقف المديونية يجب أن يكون صفراً أو أكثر');
    }

    const normalizedPhone = this.normalizePhoneNumber(dto.phoneNumber);
    if (!normalizedPhone) {
      throw new BadRequestException('رقم الهاتف المدخل غير صالح');
    }
    const requiresReceiverInput = dto.connectionType === 'SUPPLIER';

    const requestSource = dto.requestSource || (dto.connectionType === 'CUSTOMER' ? 'CUSTOMERS' : 'SUPPLIERS');

    // Check if sender is trying to link themselves
    const senderBusiness = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (senderBusiness?.phoneNumber === normalizedPhone) {
      throw new BadRequestException('لا يمكنك الارتباط بنفسك');
    }

    // Search for a registered business with this phone
    let targetBusiness = await this.prisma.business.findFirst({
      where: { phoneNumber: normalizedPhone },
      include: { user: true },
    });

    // Also search by user phone if not found via business
    if (!targetBusiness) {
      const targetUser = await this.prisma.user.findFirst({
        where: { phoneNumber: normalizedPhone, isActive: true },
        include: { business: true },
      });
      if (targetUser?.business) {
        targetBusiness = targetUser.business as any;
        (targetBusiness as any).user = targetUser;
      }
    }

    // ── CASE 1: Receiver is a registered user ─────────────────────────────
    if (targetBusiness) {
      if (targetBusiness.id === businessId) {
        throw new BadRequestException('لا يمكنك الارتباط بنفسك');
      }

      const requestedRole = dto.connectionType;
      const invertedRole = requestedRole === 'CUSTOMER' ? 'SUPPLIER' : 'CUSTOMER';

      // Check for existing connection
      const existing = await this.prisma.connection.findFirst({
        where: {
          OR: [
            { requesterId: businessId, receiverId: targetBusiness.id, connectionType: requestedRole },
            { requesterId: targetBusiness.id, receiverId: businessId, connectionType: invertedRole },
          ],
        },
      });

      if (existing) {
        if (existing.status === 'ACCEPTED' || existing.status === 'PENDING') {
          const msg = requestedRole === 'CUSTOMER'
            ? 'هذا العميل موجود بالفعل أو لديه طلب ارتباط معلق'
            : 'هذا المورد موجود بالفعل أو لديه طلب ارتباط معلق';
          throw new ConflictException(msg);
        }
        if (existing.status === 'BLOCKED') {
          throw new BadRequestException('الارتباط محظور. يجب إلغاء الحظر أولاً');
        }
        if (existing.status === 'REJECTED') {
          if (existing.retryCount >= 3) {
            throw new BadRequestException('لقد استنفدت الحد الأقصى لمحاولات الإرسال (3 محاولات)');
          }
          const lastRequested = existing.lastRequestedAt ? new Date(existing.lastRequestedAt).getTime() : 0;
          const cooldownMs = 24 * 60 * 60 * 1000;
          if (Date.now() - lastRequested < cooldownMs) {
            const hoursLeft = Math.ceil((cooldownMs - (Date.now() - lastRequested)) / (60 * 60 * 1000));
            throw new BadRequestException(`يرجى الانتظار ${hoursLeft} ساعة قبل إعادة المحاولة`);
          }
        }
      }

      try {
        return await this.prisma.$transaction(async (tx) => {
          let finalConnection: any;

          if (existing && existing.status === 'REJECTED') {
            finalConnection = await tx.connection.update({
              where: { id: existing.id },
              data: {
                status: 'PENDING',
                requesterId: businessId,
                receiverId: targetBusiness!.id,
                connectionType: dto.connectionType,
                requestSource,
                retryCount: { increment: 1 },
                isReadReceiver: false,
                lastRequestedAt: new Date(),
                requiresReceiverInput,
                pendingOpenBalance: requiresReceiverInput ? null : (dto.openingBalance ?? null),
                pendingCreditLimit: requiresReceiverInput ? null : (dto.creditLimit ?? null),
              },
              include: {
                requester: true,
                receiver: { include: { user: true } },
              },
            });
          } else {
            finalConnection = await tx.connection.create({
              data: {
                requesterId: businessId,
                receiverId: targetBusiness!.id,
                connectionType: dto.connectionType,
                requestSource,
                status: 'PENDING',
                isReadReceiver: false,
                lastRequestedAt: new Date(),
                requiresReceiverInput,
                pendingOpenBalance: requiresReceiverInput ? null : (dto.openingBalance ?? null),
                pendingCreditLimit: requiresReceiverInput ? null : (dto.creditLimit ?? null),
              },
              include: {
                requester: true,
                receiver: { include: { user: true } },
              },
            });
          }

          await tx.auditLog.create({
            data: {
              userId,
              businessId,
              action: 'SEND_RELATIONSHIP_REQUEST',
              resource: 'CONNECTION',
              resourceId: finalConnection.id,
              details: {
                connectionType: dto.connectionType,
                receiverPhone: normalizedPhone,
                requiresReceiverInput,
                registeredReceiver: true,
              },
            },
          });

          // Notify registered receiver
          const receiverUserId = (targetBusiness as any).user?.id;
          if (receiverUserId) {
            await this.notificationsService.sendPushNotification(
              receiverUserId,
              'طلب ارتباط جديد',
              `يريد ${finalConnection.requester.name} الارتباط بحسابك كـ${dto.connectionType === 'CUSTOMER' ? 'مورد' : 'عميل'}.`,
              {
                type: 'connection_request',
                notificationType: 'connection_request',
                entityType: 'connection_request',
                entityId: finalConnection.id,
                requestId: finalConnection.id,
                requiresInput: requiresReceiverInput ? 'true' : 'false',
              },
            );
          }

          this.eventsGateway.emitToBusiness(targetBusiness!.id, 'NEW_CONNECTION_REQUEST', {
            id: finalConnection.id,
            requesterName: finalConnection.requester.name,
            connectionType: dto.connectionType === 'SUPPLIER' ? 'CUSTOMER' : 'SUPPLIER',
            requiresInput: requiresReceiverInput,
          });

          return this.normalizeConnection(finalConnection, businessId);
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          throw new ConflictException('هناك طلب ارتباط قائم بالفعل لهذا الطرف');
        }
        throw err;
      }
    }

    // ── CASE 2: Receiver is NOT registered yet ────────────────────────────
    // Validate that name/businessName are provided for unregistered users
    if (!dto.personalName && !dto.businessName) {
      throw new BadRequestException('يجب إدخال اسم الشخص أو اسم النشاط عند الإضافة لمستخدم غير مسجل');
    }

    // Check for existing pending request to same phone number
    const existingByPhone = await this.prisma.connection.findFirst({
      where: {
        requesterId: businessId,
        receiverPhone: normalizedPhone,
        status: 'PENDING',
        connectionType: dto.connectionType,
      },
    });

    if (existingByPhone) {
      throw new ConflictException(
        dto.connectionType === 'CUSTOMER'
          ? 'لديك طلب ارتباط معلق بالفعل لهذا الرقم كعميل'
          : 'لديك طلب ارتباط معلق بالفعل لهذا الرقم كمورد',
      );
    }

    // Create pending connection with phone — no shadow user
    try {
      const pendingConnection = await this.prisma.connection.create({
        data: {
          requesterId: businessId,
          receiverId: null,
          receiverPhone: normalizedPhone,
          connectionType: dto.connectionType,
          requestSource,
          status: 'PENDING',
          isReadReceiver: false,
          lastRequestedAt: new Date(),
          requiresReceiverInput,
          pendingName: dto.personalName ?? null,
          pendingBizName: dto.businessName ?? null,
          pendingOpenBalance: requiresReceiverInput ? null : (dto.openingBalance ?? null),
          pendingCreditLimit: requiresReceiverInput ? null : (dto.creditLimit ?? null),
        },
        include: { requester: true },
      });

      await this.prisma.auditLog.create({
        data: {
          userId,
          businessId,
          action: 'SEND_RELATIONSHIP_REQUEST',
          resource: 'CONNECTION',
          resourceId: pendingConnection.id,
          details: {
            connectionType: dto.connectionType,
            receiverPhone: normalizedPhone,
            requiresReceiverInput,
            registeredReceiver: false,
          },
        },
      });

      return {
        id: pendingConnection.id,
        status: 'PENDING',
        connectionType: dto.connectionType,
        receiverPhone: normalizedPhone,
        pendingName: dto.personalName,
        pendingBizName: dto.businessName,
        requiresReceiverInput,
        registeredReceiver: false,
        message: 'تم حفظ الطلب. سيظهر للطرف الآخر فور تسجيله في النظام.',
      };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException(
          dto.connectionType === 'CUSTOMER'
            ? 'لديك طلب ارتباط معلق بالفعل لهذا الرقم كعميل'
            : 'لديك طلب ارتباط معلق بالفعل لهذا الرقم كمورد',
        );
      }
      throw err;
    }
  }

  /**
   * Called by AuthService after a new user registers.
   * Finds all PENDING connections where receiverPhone matches the new user's phone
   * and migrates them to use the actual receiverId atomically inside a Prisma Transaction.
   * Notifications are dispatched after successful transaction commit.
   * Returns count of linked requests.
   */
  async linkPendingRequestsAfterRegistration(
    phoneNumber: string,
    newBusinessId: string,
    newUserId: string,
  ): Promise<number> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    if (!normalizedPhone) return 0;

    const notificationsToSend: Array<{
      title: string;
      body: string;
      payload: any;
      connectionId: string;
    }> = [];

    // Atomic DB Transaction: migrate all pending requests or rollback on error
    const linkedCount = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.connection.findMany({
        where: {
          receiverPhone: normalizedPhone,
          receiverId: null,
          status: 'PENDING',
        },
        include: { requester: true },
      });

      if (pending.length === 0) return 0;

      let count = 0;
      for (const conn of pending) {
        // Check uniqueness before migrating
        const alreadyExists = await tx.connection.findFirst({
          where: {
            requesterId: conn.requesterId,
            receiverId: newBusinessId,
            connectionType: conn.connectionType,
            id: { not: conn.id },
          },
        });

        if (alreadyExists) {
          // Duplicate — cancel the phone-based pending request
          await tx.connection.update({
            where: { id: conn.id },
            data: { status: 'CANCELLED', receiverPhone: null },
          });
          continue;
        }

        // Migrate receiverPhone → receiverId atomically
        await tx.connection.update({
          where: { id: conn.id },
          data: {
            receiverId: newBusinessId,
            receiverPhone: null,
          },
        });

        const notifTitle =
          conn.connectionType === 'CUSTOMER'
            ? 'طلب ارتباط بانتظارك كمورد'
            : 'طلب ارتباط بانتظارك كعميل';
        const notifBody = `${conn.requester.name} يريد الارتباط بحسابك. يمكنك قبول أو رفض الطلب.`;

        notificationsToSend.push({
          title: notifTitle,
          body: notifBody,
          payload: {
            type: 'connection_request',
            notificationType: 'connection_request',
            entityType: 'connection_request',
            entityId: conn.id,
            requestId: conn.id,
            requiresInput: conn.requiresReceiverInput ? 'true' : 'false',
          },
          connectionId: conn.id,
        });

        count++;
      }
      return count;
    });

    // Safely send push notifications and socket events AFTER transaction commits
    for (const item of notificationsToSend) {
      await this.notificationsService
        .sendPushNotification(
          newUserId,
          item.title,
          item.body,
          item.payload,
        )
        .catch((err) =>
          this.logger.warn(
            `Failed to send push notification for connection ${item.connectionId}: ${err?.message}`,
          ),
        );

      this.eventsGateway.emitToBusiness(newBusinessId, 'NEW_CONNECTION_REQUEST', {
        id: item.connectionId,
        requiresInput: item.payload.requiresInput === 'true',
      });
    }

    return linkedCount;
  }

  /**
   * Get pending connection requests by phone number (for admin/debug).
   */
  async getPendingRequestsByPhone(phone: string) {
    return this.prisma.connection.findMany({
      where: { receiverPhone: phone, status: 'PENDING' },
      include: { requester: true },
    });
  }
}
