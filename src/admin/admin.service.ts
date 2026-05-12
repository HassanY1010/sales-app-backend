import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { AdminUsersQueryDto, ChangeUserRoleDto, ToggleUserStatusDto } from './dto/admin-user.dto';
import { AdminBusinessesQueryDto, ToggleBusinessStatusDto, BusinessStatsDto } from './dto/admin-business.dto';
import { AdminOrdersQueryDto } from './dto/admin-order.dto';
import { AdminTransactionsQueryDto } from './dto/admin-transaction.dto';
import Decimal from 'decimal.js';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    const formattedMonthlyRevenue = monthlyRevenue.map(row => ({
      month: row.month,
      total: row.total?.toString() || '0'
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
    const { page = 1, limit = 10, search, userType, isActive, sortBy = 'createdAt', sortOrder = 'desc' } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [
        { fullName: { contains: search } },
        { email: { contains: search } },
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
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
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
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    const updated = await this.prisma.user.update({
      where: { id: dto.userId },
      data: { isActive: dto.isActive },
    });

    await this.logAdminAction(adminId, 'TOGGLE_USER_STATUS', 'USER', dto.userId, {
      oldStatus: user.isActive,
      newStatus: dto.isActive,
    });

    return updated;
  }

  async resetUserPassword(userId: string, adminId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    // Default password for reset
    const defaultPassword = 'User123456';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    await this.logAdminAction(adminId, 'RESET_USER_PASSWORD', 'USER', userId, {
      message: 'Password reset to default',
    });

    return { success: true, message: 'تم إعادة تعيين كلمة المرور إلى: User123456' };
  }

  // ==================== Businesses Management ====================
  async getBusinesses(query: AdminBusinessesQueryDto) {
    const { page = 1, limit = 10, search, businessType, sortBy = 'createdAt', sortOrder = 'desc' } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { email: { contains: search } },
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
          user: { select: { id: true, fullName: true, email: true, phoneNumber: true, isActive: true } },
          _count: { select: { sentConnections: true, receivedConnections: true, sentOrders: true } },
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
      include: { user: true }
    });
    if (!business) {
      throw new NotFoundException('الشركة غير موجودة');
    }

    const updated = await this.prisma.business.update({
      where: { id: dto.businessId },
      data: { user: { update: { isActive: dto.isActive } } },
      include: { user: true },
    });

    await this.logAdminAction(adminId, 'TOGGLE_BUSINESS_STATUS', 'BUSINESS', dto.businessId, {
      oldStatus: business.user.isActive,
      newStatus: dto.isActive,
    });

    return updated;
  }

  async getBusinessStats(dto: BusinessStatsDto) {
    const { businessId, startDate, endDate } = dto;

    const where: any = {};
    if (businessId) where.OR = [{ senderId: businessId }, { receiverId: businessId }];
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
      .filter(o => o.senderId === businessId)
      .reduce((sum, o) => sum.plus(o.total), new Decimal(0));
    
    const totalPurchases = orders
      .filter(o => o.receiverId === businessId)
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
    const { page = 1, limit = 10, search, status, isCash, startDate, endDate, minAmount, maxAmount, sortBy = 'createdAt', sortOrder = 'desc' } = query;
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
        { orderNumber: { contains: search } },
        { sender: { name: { contains: search } } },
        { receiver: { name: { contains: search } } },
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
    const { page = 1, limit = 10, search, transactionType, startDate, endDate, minAmount, maxAmount, sortBy = 'createdAt', sortOrder = 'desc' } = query;
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
        { note: { contains: search } },
        { sender: { name: { contains: search } } },
        { receiver: { name: { contains: search } } },
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
  async getConnections(query: PaginationDto & { status?: string; connectionType?: string }) {
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

  // ==================== Expenses ====================
  async getExpenses(query: PaginationDto & { userId?: string; startDate?: string; endDate?: string }) {
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
  async sendNotification(userId: string, title: string, body: string, type?: string) {
    const notification = await this.prisma.notification.create({
      data: { userId, title, body, type },
    });

    await this.logAdminAction(userId, 'SEND_NOTIFICATION', 'NOTIFICATION', notification.id, { title, body, type });

    return notification;
  }

  async sendBulkNotification(userIds: string[], title: string, body: string, type?: string) {
    const notifications = await this.prisma.notification.createMany({
      data: userIds.map(userId => ({ userId, title, body, type })),
    });

    await this.logAdminAction(userIds[0], 'SEND_BULK_NOTIFICATION', 'NOTIFICATION', null, {
      userCount: userIds.length,
      title,
      body,
      type,
    });

    return notifications;
  }

  async getNotifications(query: PaginationDto & { userId?: string; isRead?: boolean }) {
    const { page = 1, limit = 10, userId, isRead } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (userId) where.userId = userId;
    if (isRead !== undefined) where.isRead = isRead;

    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      data: notifications,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
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
                select: { name: true }
              }
            }
          }
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
    return this.prisma.suggestion.update({
      where: { id: suggestionId },
      data: { status },
    });
  }

  // ==================== Audit Logs ====================
  async getAuditLogs(query: PaginationDto & { userId?: string; action?: string; resource?: string }) {
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

    const [transactions, orders, accounts] = await Promise.all([
      this.prisma.transaction.findMany({ where }),
      this.prisma.order.findMany({ where: { ...where } }),
      this.prisma.account.findMany(),
    ]);

    const totalRevenue = transactions.reduce((sum, t) => sum.plus(t.amount), new Decimal(0));
    const totalOrderValue = orders.reduce((sum, o) => sum.plus(o.total), new Decimal(0));
    const totalReceivable = accounts.reduce((sum, a) => sum.plus(a.totalDebit), new Decimal(0));
    const totalPayable = accounts.reduce((sum, a) => sum.plus(a.totalCredit), new Decimal(0));

    return {
      totalRevenue: totalRevenue.toString(),
      totalOrderValue: totalOrderValue.toString(),
      totalReceivable: totalReceivable.toString(),
      totalPayable: totalPayable.toString(),
      netBalance: totalReceivable.minus(totalPayable).toString(),
    };
  }

  // ==================== System Settings ====================
  async getSystemSettings() {
    return this.prisma.systemSettings.findMany();
  }

  async updateSystemSetting(key: string, value: any, isPublic: boolean = false) {
    return this.prisma.systemSettings.upsert({
      where: { key },
      create: { key, value, isPublic },
      update: { value, isPublic },
    });
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
}
