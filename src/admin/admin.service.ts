import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import {
  AdminUsersQueryDto,
  ChangeUserRoleDto,
  ToggleUserStatusDto,
} from './dto/admin-user.dto';
import {
  AdminBusinessesQueryDto,
  ToggleBusinessStatusDto,
  BusinessStatsDto,
} from './dto/admin-business.dto';
import { AdminOrdersQueryDto } from './dto/admin-order.dto';
import { AdminTransactionsQueryDto } from './dto/admin-transaction.dto';
import Decimal from 'decimal.js';
import * as bcrypt from 'bcrypt';
import { NotificationsService } from '../notifications/notifications.service';
import { FinanceService } from '../finance/finance.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly financeService: FinanceService,
  ) {}

  // ==================== Dashboard Stats ====================
  async getDashboardStats() {
    const [
      totalUsers,
      totalBusinesses,
      totalOrders,
      totalRevenue,
      recentOrders,
      recentTransactions,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.business.count(),
      this.prisma.order.count(),
      this.prisma.transaction.aggregate({
        _sum: { amount: true },
      }),
      this.prisma.order.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          sender: { select: { name: true } },
          receiver: { select: { name: true } },
        },
      }),
      this.prisma.transaction.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          sender: { select: { name: true } },
          receiver: { select: { name: true } },
        },
      }),
    ]);

    const ordersByStatus = await this.prisma.order.groupBy({
      by: ['status'],
      _count: true,
    });

    const monthlyRevenue = await this.prisma.$queryRaw<any[]>`
      SELECT 
        TO_CHAR("createdAt", 'YYYY-MM') as month,
        SUM(amount) as total
      FROM transactions
      WHERE "createdAt" >= NOW() - INTERVAL '6 months'
      GROUP BY TO_CHAR("createdAt", 'YYYY-MM')
      ORDER BY month ASC
    `;

    // Ensure numeric types from raw query are converted to strings for JSON safety
    const formattedMonthlyRevenue = monthlyRevenue.map((row) => ({
      month: row.month,
      total: row.total?.toString() || '0',
    }));

    return {
      totalUsers,
      totalBusinesses,
      totalOrders,
      totalRevenue: totalRevenue._sum.amount?.toString() || '0',
      ordersByStatus,
      monthlyRevenue: formattedMonthlyRevenue,
      recentOrders,
      recentTransactions,
    };
  }

  // ==================== Users Management ====================
  async getUsers(query: AdminUsersQueryDto, adminId: string) {
    const {
      page = 1,
      limit = 10,
      search,
      userType,
      isActive,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phoneNumber: { contains: search } },
      ];
    }
    if (userType) where.userType = userType;
    if (isActive !== undefined) where.isActive = isActive;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: {
          id: true,
          email: true,
          fullName: true,
          phoneNumber: true,
          userType: true,
          role: true,
          isActive: true,
          isEmailVerified: true,
          createdAt: true,
          updatedAt: true,
          business: {
            select: {
              id: true,
              subscriptionStatus: true,
              subscriptionExpiry: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        business: true,
        expenses: { take: 10, orderBy: { createdAt: 'desc' } },
        _count: { select: { notifications: true, auditLogs: true } },
      },
    });

    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    return user;
  }

  async changeUserRole(dto: ChangeUserRoleDto, adminId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    const updated = await this.prisma.user.update({
      where: { id: dto.userId },
      data: { role: dto.role },
    });

    await this.logAdminAction(adminId, 'CHANGE_USER_ROLE', 'USER', dto.userId, {
      oldRole: user.role,
      newRole: dto.role,
    });

    return updated;
  }

  async toggleUserStatus(dto: ToggleUserStatusDto, adminId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    const updated = await this.prisma.user.update({
      where: { id: dto.userId },
      data: { isActive: dto.isActive },
    });

    await this.logAdminAction(
      adminId,
      'TOGGLE_USER_STATUS',
      'USER',
      dto.userId,
      {
        oldStatus: user.isActive,
        newStatus: dto.isActive,
      },
    );

    if (!dto.isActive) {
      try {
        await this.notificationsService.notifyUser(
          user.id,
          'تعليق الحساب',
          'تم تعليق حسابك من قبل الإدارة. يرجى التواصل مع الدعم لمزيد من التفاصيل.',
          { type: 'ACCOUNT_SUSPENDED' },
        );
      } catch (err: any) {
        this.logger.error(
          `Failed to send suspension notification to user ${user.id}: ${err.message}`,
        );
      }
    }

    return updated;
  }

  async resetUserPassword(userId: string, adminId: string, dto?: any) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    const forcePasswordChange = dto?.forcePasswordChange !== false;
    const expiryHours = dto?.expiryHours || 24;
    
    let temporaryPassword = dto?.customPassword || this.generateTemporaryPassword();
    if (temporaryPassword.length < 6) {
      throw new BadRequestException('كلمة المرور المؤقتة يجب ألا تقل عن 6 خانات');
    }
    
    const hashedTempPassword = await bcrypt.hash(temporaryPassword, 10);
    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + expiryHours);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        tempPasswordHash: hashedTempPassword,
        tempPasswordExpiry: expiryDate,
        forcePasswordChange: forcePasswordChange,
        passwordResetCount: { increment: 1 },
        lastPasswordResetAt: new Date(),
        lastPasswordResetById: adminId,
      },
    });

    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.logAdminAction(adminId, 'RESET_USER_PASSWORD_ADVANCED', 'USER', userId, {
      forcePasswordChange,
      expiryHours,
      resetById: adminId,
    });

    return { success: true, temporaryPassword, expiryDate };
  }

  async deleteUser(userId: string, adminId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { business: true },
    });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    // Log BEFORE deletion so record exists
    await this.logAdminAction(adminId, 'DELETE_USER', 'USER', userId, {
      email: user.email,
      phoneNumber: user.phoneNumber,
      userType: user.userType,
      businessId: user.business?.id,
    });

    await this.prisma.$transaction(async (tx) => {
      // 1. If user is an agent, set referredByAgentId to null for all users they referred
      const agent = await tx.agent.findFirst({ where: { userId } });
      if (agent) {
        await tx.user.updateMany({
          where: { referredByAgentId: agent.id },
          data: { referredByAgentId: null },
        });
      }

      // 2. If user has a business, delete the business and all its dependencies
      const businessId = user.business?.id;
      if (businessId) {
        // Find all connections related to the business
        const connections = await tx.connection.findMany({
          where: {
            OR: [
              { requesterId: businessId },
              { receiverId: businessId },
            ],
          },
        });
        const connectionIds = connections.map((c) => c.id);

        if (connectionIds.length > 0) {
          // Delete accounts pointing to these connections
          await tx.account.deleteMany({
            where: { connectionId: { in: connectionIds } },
          });
          // Delete reminder logs pointing to these connections
          await tx.dueReminderLog.deleteMany({
            where: { connectionId: { in: connectionIds } },
          });
          // Delete connection commissions
          await tx.commission.deleteMany({
            where: { subscription: { businessId } },
          });
          // Delete connections
          await tx.connection.deleteMany({
            where: { id: { in: connectionIds } },
          });
        }

        // Delete due reminders for this business
        await tx.dueReminderLog.deleteMany({
          where: { recipientBusinessId: businessId },
        });

        // Delete adjustment requests for this business
        await tx.adjustmentRequest.deleteMany({
          where: {
            OR: [
              { requesterBusinessId: businessId },
              { receiverBusinessId: businessId },
            ],
          },
        });

        // Delete payment requests for this business
        await tx.paymentRequest.deleteMany({
          where: { businessId },
        });

        // Delete expenses for this business
        await tx.expense.deleteMany({
          where: { businessId },
        });

        // Delete order items of orders for this business
        const orders = await tx.order.findMany({
          where: {
            OR: [
              { senderId: businessId },
              { receiverId: businessId },
            ],
          },
        });
        const orderIds = orders.map((o) => o.id);
        if (orderIds.length > 0) {
          await tx.orderItem.deleteMany({
            where: { orderId: { in: orderIds } },
          });
          await tx.order.deleteMany({
            where: { id: { in: orderIds } },
          });
        }

        // Delete transactions for this business
        await tx.transaction.deleteMany({
          where: {
            OR: [
              { senderId: businessId },
              { receiverId: businessId },
            ],
          },
        });

        // Delete user subscriptions for this business
        await tx.userSubscription.deleteMany({
          where: { businessId },
        });


        // Delete the business
        await tx.business.delete({
          where: { id: businessId },
        });
      }

      // 3. Delete user specific dependencies
      await tx.userSubscription.deleteMany({ where: { userId } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.expense.deleteMany({ where: { userId } });
      await tx.auditLog.deleteMany({ where: { userId } });
      
      // Delete adjustment requests created or reviewed by this user
      await tx.adjustmentRequest.deleteMany({
        where: {
          OR: [
            { createdById: userId },
            { reviewedById: userId },
          ],
        },
      });

      // Delete payment requests
      await tx.paymentRequest.deleteMany({
        where: {
          OR: [
            { userId },
            { approvedById: userId },
          ],
        },
      });

      // Delete suggestions
      await tx.suggestion.deleteMany({ where: { userId } });

      // Delete commissions
      await tx.commission.deleteMany({ where: { customerId: userId } });

      // Revoke all active sessions
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      // Finally delete the user
      await tx.user.delete({ where: { id: userId } });
    });

    return { success: true, message: 'تم حذف المستخدم بنجاح' };
  }

  // ==================== Businesses Management ====================
  async getBusinesses(query: AdminBusinessesQueryDto) {
    const {
      page = 1,
      limit = 10,
      search,
      businessType,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phoneNumber: { contains: search } },
      ];
    }
    if (businessType) where.businessType = businessType;

    const [businesses, total] = await Promise.all([
      this.prisma.business.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phoneNumber: true,
              isActive: true,
            },
          },
          _count: {
            select: {
              sentConnections: true,
              receivedConnections: true,
              sentOrders: true,
            },
          },
        },
      }),
      this.prisma.business.count({ where }),
    ]);

    return {
      data: businesses,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getBusinessById(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: {
        user: true,
        sentConnections: { include: { receiver: true }, take: 10 },
        receivedConnections: { include: { requester: true }, take: 10 },
        sentOrders: { take: 10, orderBy: { createdAt: 'desc' } },
        receivedOrders: { take: 10, orderBy: { createdAt: 'desc' } },
      },
    });

    if (!business) {
      throw new NotFoundException('الشركة غير موجودة');
    }

    return business;
  }

  async toggleBusinessStatus(dto: ToggleBusinessStatusDto, adminId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: dto.businessId },
      include: { user: true },
    });
    if (!business) {
      throw new NotFoundException('الشركة غير موجودة');
    }

    const updated = await this.prisma.business.update({
      where: { id: dto.businessId },
      data: { user: { update: { isActive: dto.isActive } } },
      include: { user: true },
    });

    await this.logAdminAction(
      adminId,
      'TOGGLE_BUSINESS_STATUS',
      'BUSINESS',
      dto.businessId,
      {
        oldStatus: business.user.isActive,
        newStatus: dto.isActive,
      },
    );

    if (!dto.isActive && business.user) {
      try {
        await this.notificationsService.notifyUser(
          business.user.id,
          'تعليق الحساب',
          'تم تعليق حساب منشأتك من قبل الإدارة. يرجى التواصل مع الدعم لمزيد من التفاصيل.',
          { type: 'ACCOUNT_SUSPENDED' },
        );
      } catch (err: any) {
        this.logger.error(
          `Failed to send suspension notification to user ${business.user.id}: ${err.message}`,
        );
      }
    }

    return updated;
  }

  async getBusinessStats(dto: BusinessStatsDto) {
    const { businessId, startDate, endDate } = dto;

    const where: any = {};
    if (businessId)
      where.OR = [{ senderId: businessId }, { receiverId: businessId }];
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [orders, transactions, accountSummary] = await Promise.all([
      this.prisma.order.findMany({
        where: { OR: [{ senderId: businessId }, { receiverId: businessId }] },
        include: { sender: true, receiver: true },
      }),
      this.prisma.transaction.findMany({ where }),
      this.prisma.account.findFirst({
        where: {
          connection: {
            OR: [{ requesterId: businessId }, { receiverId: businessId }],
          },
        },
      }),
    ]);

    const totalSales = orders
      .filter((o) => o.senderId === businessId)
      .reduce((sum, o) => sum.plus(o.total), new Decimal(0));

    const totalPurchases = orders
      .filter((o) => o.receiverId === businessId)
      .reduce((sum, o) => sum.plus(o.total), new Decimal(0));

    return {
      orders: orders.length,
      transactions: transactions.length,
      totalSales: totalSales.toString(),
      totalPurchases: totalPurchases.toString(),
      accountBalance: accountSummary?.balance?.toString() || '0',
    };
  }

  // ==================== Orders Management ====================
  async getOrders(query: AdminOrdersQueryDto) {
    const {
      page = 1,
      limit = 10,
      search,
      status,
      isCash,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (isCash !== undefined) where.isCash = isCash;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    if (minAmount) where.total = { ...where.total, gte: minAmount };
    if (maxAmount) where.total = { ...where.total, lte: maxAmount };
    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { sender: { name: { contains: search, mode: 'insensitive' } } },
        { receiver: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          sender: { select: { id: true, name: true } },
          receiver: { select: { id: true, name: true } },
          _count: { select: { items: true, transactions: true } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: orders,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getOrderById(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        sender: { include: { user: true } },
        receiver: { include: { user: true } },
        items: true,
        transactions: true,
      },
    });

    if (!order) {
      throw new NotFoundException('الطلب غير موجود');
    }

    return order;
  }

  // ==================== Transactions Management ====================
  async getTransactions(query: AdminTransactionsQueryDto) {
    const {
      page = 1,
      limit = 10,
      search,
      transactionType,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (transactionType) where.transactionType = transactionType;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    if (minAmount) where.amount = { ...where.amount, gte: minAmount };
    if (maxAmount) where.amount = { ...where.amount, lte: maxAmount };
    if (search) {
      where.OR = [
        { note: { contains: search, mode: 'insensitive' } },
        { sender: { name: { contains: search, mode: 'insensitive' } } },
        { receiver: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          sender: { select: { id: true, name: true } },
          receiver: { select: { id: true, name: true } },
          order: { select: { id: true, orderNumber: true } },
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      data: transactions,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ==================== Connections Management ====================
  async getConnections(
    query: PaginationDto & { status?: string; connectionType?: string },
  ) {
    const { page = 1, limit = 10, status, connectionType } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (connectionType) where.connectionType = connectionType;

    const [connections, total] = await Promise.all([
      this.prisma.connection.findMany({
        where,
        skip,
        take: limit,
        include: {
          requester: { select: { id: true, name: true } },
          receiver: { select: { id: true, name: true } },
          account: true,
        },
      }),
      this.prisma.connection.count({ where }),
    ]);

    return {
      data: connections,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ==================== Accounts (Ledger) ====================
  async getAccounts(query: PaginationDto & { search?: string }) {
    const { page = 1, limit = 10, search } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [
        { connection: { requester: { name: { contains: search } } } },
        { connection: { receiver: { name: { contains: search } } } },
      ];
    }

    const [accounts, total] = await Promise.all([
      this.prisma.account.findMany({
        where,
        skip,
        take: limit,
        include: {
          connection: {
            include: {
              requester: { select: { id: true, name: true } },
              receiver: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.account.count({ where }),
    ]);

    return {
      data: accounts,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getAccountById(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      include: {
        connection: {
          include: {
            requester: true,
            receiver: true,
          },
        },
      },
    });

    if (!account) {
      throw new NotFoundException('الحساب غير موجود');
    }

    return account;
  }

  async getDueAccounts(query: PaginationDto & { includeFuture?: string }) {
    const { page = 1, limit = 10, includeFuture } = query;
    const skip = (page - 1) * limit;
    const now = new Date();

    const where: any = {
      dueDate: includeFuture === 'true' ? { not: null } : { lte: now },
      NOT: { balance: 0 },
    };

    const [accounts, total] = await Promise.all([
      this.prisma.account.findMany({
        where,
        skip,
        take: limit,
        orderBy: { dueDate: 'asc' },
        include: {
          connection: {
            include: {
              requester: {
                select: {
                  id: true,
                  name: true,
                  user: { select: { id: true, fullName: true } },
                },
              },
              receiver: {
                select: {
                  id: true,
                  name: true,
                  user: { select: { id: true, fullName: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.account.count({ where }),
    ]);

    return {
      data: accounts.map((account) => {
        const balance = new Decimal(account.balance as any);
        return {
          ...account,
          amount: balance.abs().toString(),
          debtor: balance.greaterThan(0)
            ? account.connection.receiver
            : account.connection.requester,
          creditor: balance.greaterThan(0)
            ? account.connection.requester
            : account.connection.receiver,
          isOverdue: account.dueDate ? account.dueDate <= now : false,
        };
      }),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getAdjustmentRequests(
    query: PaginationDto & { status?: string; targetType?: string },
  ) {
    const { page = 1, limit = 10, status, targetType } = query;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (status) where.status = status;
    if (targetType) where.targetType = targetType;

    const [requests, total] = await Promise.all([
      this.prisma.adjustmentRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          requesterBusiness: { select: { id: true, name: true } },
          receiverBusiness: { select: { id: true, name: true } },
          createdBy: { select: { id: true, fullName: true, email: true } },
          reviewedBy: { select: { id: true, fullName: true, email: true } },
        },
      }),
      this.prisma.adjustmentRequest.count({ where }),
    ]);

    return {
      data: requests,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async rejectAdjustmentRequest(
    id: string,
    rejectionReason: string,
    adminId: string,
  ) {
    if (!rejectionReason || rejectionReason.trim().length < 5) {
      throw new BadRequestException('Rejection reason is required');
    }

    const request = await this.prisma.adjustmentRequest.findUnique({
      where: { id },
    });
    if (!request) {
      throw new NotFoundException('Adjustment request not found');
    }
    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `Adjustment request is already ${request.status}`,
      );
    }

    const rejected = await this.prisma.adjustmentRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectionReason: rejectionReason.trim(),
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
    });

    await this.logAdminAction(
      adminId,
      'REJECT_ADJUSTMENT_REQUEST',
      'ADJUSTMENT_REQUEST',
      id,
      {
        targetType: request.targetType,
        targetId: request.targetId,
        rejectionReason: rejectionReason.trim(),
      },
    );

    return rejected;
  }

  /**
   * Admin-level force-approve of an adjustment request.
   * Bypasses the receiverBusinessId check that restricts the business-level service.
   * Updates the target record amount, records a ledger ADJUSTMENT, and rebuilds balance.
   * (Blocker-02)
   */
  async adminApproveAdjustmentRequest(id: string, adminId: string) {
    const request = await this.prisma.adjustmentRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException('Adjustment request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `Adjustment request is already ${request.status}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Non-amount metadata updates
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

      // 2. Amount change
      if (request.requestedAmount) {
        const requestedAmount = new Decimal(request.requestedAmount as any);

        if (request.targetType === 'ORDER') {
          const order = await tx.order.findUnique({
            where: { id: request.targetId },
          });
          if (!order) throw new NotFoundException('Target order not found');

          // Update order total
          await tx.order.update({
            where: { id: request.targetId },
            data: { total: requestedAmount.toString() },
          });

          // Update linked SALE transaction
          const linkedTx = await tx.transaction.findFirst({
            where: { orderId: request.targetId, transactionType: 'SALE' },
          });
          if (linkedTx) {
            await tx.transaction.update({
              where: { id: linkedTx.id },
              data: { amount: requestedAmount.toString() },
            });
          }

          // Rebuild account balance for these two parties
          const connection = await tx.connection.findFirst({
            where: {
              OR: [
                { requesterId: order.senderId, receiverId: order.receiverId },
                { requesterId: order.receiverId, receiverId: order.senderId },
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
        } else {
          const transaction = await tx.transaction.findUnique({
            where: { id: request.targetId },
          });
          if (!transaction)
            throw new NotFoundException('Target transaction not found');

          await tx.transaction.update({
            where: { id: request.targetId },
            data: { amount: requestedAmount.toString() },
          });

          const connection = await tx.connection.findFirst({
            where: {
              OR: [
                {
                  requesterId: transaction.senderId,
                  receiverId: transaction.receiverId,
                },
                {
                  requesterId: transaction.receiverId,
                  receiverId: transaction.senderId,
                },
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
      }

      // 3. Mark as approved
      const approved = await tx.adjustmentRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedById: adminId,
          reviewedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          userId: adminId,
          action: 'ADMIN_APPROVE',
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
  }

  // ==================== Expenses ====================
  async getExpenses(
    query: PaginationDto & {
      userId?: string;
      startDate?: string;
      endDate?: string;
    },
  ) {
    const { page = 1, limit = 10, userId, startDate, endDate } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (userId) where.userId = userId;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [expenses, total] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, fullName: true, phoneNumber: true } },
        },
      }),
      this.prisma.expense.count({ where }),
    ]);

    return {
      data: expenses,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ==================== Notifications ====================
  async sendNotification(
    adminId: string,
    userId: string,
    title: string,
    body: string,
    type?: string,
  ) {
    const notification = await this.notificationsService.notifyUser(
      userId,
      title,
      body,
      { type: type || 'ADMIN_MESSAGE', senderId: adminId },
    );

    await this.logAdminAction(
      adminId,
      'SEND_NOTIFICATION',
      'NOTIFICATION',
      notification.id,
      { userId, title, body, type },
    );

    return notification;
  }

  async sendBulkNotification(
    adminId: string,
    userIds: string[],
    title: string,
    body: string,
    type?: string,
  ) {
    const notifications = await Promise.all(
      userIds.map((userId) =>
        this.notificationsService.notifyUser(userId, title, body, {
          type: type || 'ADMIN_MESSAGE',
          senderId: adminId,
        }),
      ),
    );

    await this.logAdminAction(
      adminId,
      'SEND_BULK_NOTIFICATION',
      'NOTIFICATION',
      null,
      {
        userCount: userIds.length,
        title,
        body,
        type,
      },
    );

    return notifications;
  }

  async getNotifications(
    query: PaginationDto & { userId?: string; isRead?: boolean },
  ) {
    const pageNum = parseInt(query.page as any, 10) || 1;
    const limitNum = parseInt(query.limit as any, 10) || 10;
    const { userId, isRead } = query;
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (userId) where.userId = userId;
    if (isRead !== undefined) {
      const isReadVal = isRead as any;
      where.isRead = isReadVal === 'true' || isReadVal === true;
    }

    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      data: notifications,
      meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    };
  }

  async getNotificationsCount(isRead?: boolean) {
    const where: any = {};
    if (isRead !== undefined) where.isRead = isRead;
    const count = await this.prisma.notification.count({ where });
    return { count };
  }

  async markNotificationAsRead(notificationId: string) {
    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });
  }

  // ==================== Suggestions ====================
  async getSuggestions(query: PaginationDto & { status?: string }) {
    const { page = 1, limit = 10, status } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;

    const [suggestions, total] = await Promise.all([
      this.prisma.suggestion.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phoneNumber: true,
              userType: true,
              business: {
                select: { name: true },
              },
            },
          },
        },
      }),
      this.prisma.suggestion.count({ where }),
    ]);

    return {
      data: suggestions,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async updateSuggestionStatus(suggestionId: string, status: string) {
    // FIX BUG-03: Validate status against allowed values before persisting
    const VALID_STATUSES = ['OPEN', 'REVIEWED', 'CLOSED'];
    if (!VALID_STATUSES.includes(status)) {
      throw new BadRequestException(
        `حالة غير صالحة. القيم المسموح بها: ${VALID_STATUSES.join(', ')}`,
      );
    }

    const suggestion = await this.prisma.suggestion.findUnique({
      where: { id: suggestionId },
    });
    if (!suggestion) {
      throw new NotFoundException('الاقتراح غير موجود');
    }

    return this.prisma.suggestion.update({
      where: { id: suggestionId },
      data: { status },
    });
  }

  // ==================== Audit Logs ====================
  async getAuditLogs(
    query: PaginationDto & {
      userId?: string;
      action?: string;
      resource?: string;
    },
  ) {
    const { page = 1, limit = 10, userId, action, resource } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (userId) where.userId = userId;
    if (action) where.action = action;
    if (resource) where.resource = resource;

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, fullName: true, email: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data: logs,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ==================== Reports ====================
  async getFinancialReport(startDate?: string, endDate?: string) {
    const where: any = {};
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    // FIX BUG-04: Use aggregate instead of findMany to avoid loading all records into memory
    const [transactionSum, orderSum, accountSums] = await Promise.all([
      this.prisma.transaction.aggregate({
        where,
        _sum: { amount: true },
        _count: { id: true },
      }),
      this.prisma.order.aggregate({
        where: { ...where },
        _sum: { total: true },
        _count: { id: true },
      }),
      this.prisma.account.aggregate({
        _sum: { totalDebit: true, totalCredit: true },
      }),
    ]);

    const totalRevenue = new Decimal(
      transactionSum._sum.amount?.toString() || '0',
    );
    const totalOrderValue = new Decimal(orderSum._sum.total?.toString() || '0');
    const totalReceivable = new Decimal(
      accountSums._sum.totalDebit?.toString() || '0',
    );
    const totalPayable = new Decimal(
      accountSums._sum.totalCredit?.toString() || '0',
    );

    return {
      totalRevenue: totalRevenue.toString(),
      totalOrderValue: totalOrderValue.toString(),
      totalReceivable: totalReceivable.toString(),
      totalPayable: totalPayable.toString(),
      netBalance: totalReceivable.minus(totalPayable).toString(),
      transactionCount: transactionSum._count.id,
      orderCount: orderSum._count.id,
    };
  }

  // ==================== System Settings ====================
  async getSystemSettings() {
    return this.prisma.systemSettings.findMany();
  }

  async updateSystemSetting(
    key: string,
    value: any,
    isPublic: boolean = false,
  ) {
    return this.prisma.systemSettings.upsert({
      where: { key },
      create: { key, value, isPublic },
      update: { value, isPublic },
    });
  }

  async getOperationsSummary() {
    const [
      users,
      inactiveUsers,
      pendingOrders,
      rejectedOrders,
      pendingConnections,
      failedPaymentRequests,
      unreadNotifications,
      recentAuditLogs,
      refreshTokenCount,
      activeRefreshTokenCount,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isActive: false } }),
      this.prisma.order.count({ where: { status: 'PENDING' } }),
      this.prisma.order.count({ where: { status: 'REJECTED' } }),
      this.prisma.connection.count({ where: { status: 'PENDING' } }),
      this.prisma.paymentRequest.count({ where: { status: 'REJECTED' } }),
      this.prisma.notification.count({ where: { isRead: false } }),
      this.prisma.auditLog.findMany({
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, fullName: true, email: true } },
        },
      }),
      this.prisma.refreshToken.count(),
      this.prisma.refreshToken.count({
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);

    return {
      health: {
        status: 'ok',
        checkedAt: new Date().toISOString(),
        database: 'connected',
      },
      security: {
        corsConfigured: Boolean(
          process.env.CORS_ORIGINS || process.env.CORS_ORIGIN,
        ),
        jwtSecretConfigured: Boolean(
          process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32,
        ),
        refreshTokensEnabled: true,
        activeSessions: activeRefreshTokenCount,
        totalRefreshTokens: refreshTokenCount,
      },
      workload: {
        users,
        inactiveUsers,
        pendingOrders,
        rejectedOrders,
        pendingConnections,
        failedPaymentRequests,
        unreadNotifications,
      },
      recentAuditLogs,
    };
  }

  // ==================== Private Helpers ====================
  private async logAdminAction(
    adminId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    details: any,
  ) {
    return this.prisma.adminAction.create({
      data: {
        adminId,
        action,
        targetType,
        targetId,
        details,
      },
    });
  }

  private generateTemporaryPassword() {
    return `Tmp-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}!`;
  }
}
