import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import Decimal from 'decimal.js';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async getDebtsToMe(businessId: string, query: any = {}) {
    // Other businesses owe me money
    const partyFilter = query.partyId
      ? {
          OR: [{ requesterId: query.partyId }, { receiverId: query.partyId }],
        }
      : {};

    const connections = await this.prisma.connection.findMany({
      where: {
        ...partyFilter,
        status: 'ACCEPTED',
        OR: [
          { requesterId: businessId, account: { balance: { gt: 0 } } },
          { receiverId: businessId, account: { balance: { lt: 0 } } },
        ],
      },
      include: {
        requester: true,
        receiver: true,
        account: true,
      },
    });

    return connections.map((conn) => {
      const isRequester = conn.requesterId === businessId;
      const otherBusiness = isRequester ? conn.receiver : conn.requester;
      const amountOwedToMe = isRequester
        ? conn.account!.balance.toString()
        : new Decimal(conn.account!.balance as any).abs().toString();

      return {
        businessId: otherBusiness.id,
        businessName: otherBusiness.name,
        amount: amountOwedToMe,
      };
    });
  }

  async getMyDebts(businessId: string, query: any = {}) {
    // I owe money to other businesses
    const partyFilter = query.partyId
      ? {
          OR: [{ requesterId: query.partyId }, { receiverId: query.partyId }],
        }
      : {};

    const connections = await this.prisma.connection.findMany({
      where: {
        ...partyFilter,
        status: 'ACCEPTED',
        OR: [
          { requesterId: businessId, account: { balance: { lt: 0 } } },
          { receiverId: businessId, account: { balance: { gt: 0 } } },
        ],
      },
      include: {
        requester: true,
        receiver: true,
        account: true,
      },
    });

    return connections.map((conn) => {
      const isRequester = conn.requesterId === businessId;
      const otherBusiness = isRequester ? conn.receiver : conn.requester;
      const amountIOwe = isRequester
        ? new Decimal(conn.account!.balance as any).abs().toString()
        : conn.account!.balance.toString();

      return {
        businessId: otherBusiness.id,
        businessName: otherBusiness.name,
        amount: amountIOwe,
      };
    });
  }

  async getSummary(businessId: string, query: any = {}) {
    // Basic dashboard summary stats
    const dateRange = this.resolveDateRange(query);

    const [orders, connections] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          OR: [{ senderId: businessId }, { receiverId: businessId }],
          ...(dateRange && { createdAt: dateRange }),
        },
      }),
      this.prisma.connection.findMany({
        where: {
          status: 'ACCEPTED',
          OR: [{ requesterId: businessId }, { receiverId: businessId }],
        },
        include: { account: true },
      }),
    ]);

    let totalSales = new Decimal(0);
    let totalPurchases = new Decimal(0);
    let receivable = new Decimal(0);
    let payable = new Decimal(0);

    orders.forEach((o) => {
      if (o.status === 'COMPLETED' || o.status === 'ACCEPTED') {
        if (o.senderId === businessId)
          totalPurchases = totalPurchases.plus(o.total as any);
        else totalSales = totalSales.plus(o.total as any);
      }
    });

    connections.forEach((c) => {
      const isRequester = c.requesterId === businessId;
      const balance = new Decimal((c.account?.balance as any) || 0);
      if (isRequester) {
        if (balance.greaterThan(0)) receivable = receivable.plus(balance);
        else payable = payable.plus(balance.abs());
      } else {
        if (balance.lessThan(0)) receivable = receivable.plus(balance.abs());
        else payable = payable.plus(balance);
      }
    });

    return {
      totalSales: totalSales.toString(),
      totalPurchases: totalPurchases.toString(),
      receivable: receivable.toString(),
      payable: payable.toString(),
      ordersCount: orders.length,
      pendingOrdersCount: orders.filter((o) => o.status === 'PENDING').length,
      customersCount: connections.filter((c) => c.connectionType === 'CUSTOMER')
        .length,
      suppliersCount: connections.filter((c) => c.connectionType === 'SUPPLIER')
        .length,
      period: this.describePeriod(query, dateRange),
    };
  }

  async getOrdersReport(businessId: string, query: any = {}) {
    const { page = 1, limit = 20 } = this.resolvePagination(query);
    const dateRange = this.resolveDateRange(query);
    const where: any = {
      OR: [{ senderId: businessId }, { receiverId: businessId }],
      ...(dateRange && { createdAt: dateRange }),
    };

    if (query.status) where.status = query.status;
    if (query.partyId) {
      where.AND = [
        {
          OR: [{ senderId: query.partyId }, { receiverId: query.partyId }],
        },
      ];
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: { sender: true, receiver: true, items: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    const totalAmount = orders.reduce(
      (sum, order) => sum.plus(order.total as any),
      new Decimal(0),
    );

    return {
      data: orders.map((order) => ({
        ...order,
        direction: order.senderId === businessId ? 'sent' : 'received',
        party: order.senderId === businessId ? order.receiver : order.sender,
      })),
      summary: {
        count: orders.length,
        totalAmount: totalAmount.toString(),
        period: this.describePeriod(query, dateRange),
      },
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
        limit,
      },
    };
  }

  async getTransactionsReport(businessId: string, query: any = {}) {
    const { page = 1, limit = 20 } = this.resolvePagination(query);
    const dateRange = this.resolveDateRange(query);
    const where: any = {
      OR: [{ senderId: businessId }, { receiverId: businessId }],
      ...(dateRange && { createdAt: dateRange }),
    };

    if (query.type) where.transactionType = query.type;
    if (query.partyId) {
      where.AND = [
        {
          OR: [{ senderId: query.partyId }, { receiverId: query.partyId }],
        },
      ];
    }

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: { sender: true, receiver: true, order: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    const totalAmount = transactions.reduce(
      (sum, transaction) => sum.plus(transaction.amount as any),
      new Decimal(0),
    );

    return {
      data: transactions.map((transaction) => ({
        ...transaction,
        direction: transaction.senderId === businessId ? 'sent' : 'received',
        party:
          transaction.senderId === businessId
            ? transaction.receiver
            : transaction.sender,
      })),
      summary: {
        count: transactions.length,
        totalAmount: totalAmount.toString(),
        period: this.describePeriod(query, dateRange),
      },
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
        limit,
      },
    };
  }

  async exportReport(businessId: string, query: any = {}) {
    const type = query.type === 'transactions' ? 'transactions' : 'orders';
    const exportQuery = {
      ...query,
      page: 1,
      limit: Math.min(Number(query.limit || 1000), 5000),
    };
    const report =
      type === 'transactions'
        ? await this.getTransactionsReport(businessId, exportQuery)
        : await this.getOrdersReport(businessId, exportQuery);

    const rows =
      type === 'transactions'
        ? report.data.map((transaction: any) => ({
            id: transaction.id,
            date: transaction.createdAt,
            type: transaction.transactionType,
            direction: transaction.direction,
            party: transaction.party?.name,
            amount: transaction.amount,
            currency: transaction.currency,
            voucherNumber: transaction.voucherNumber,
            note: transaction.note,
          }))
        : report.data.map((order: any) => ({
            id: order.id,
            orderNumber: order.orderNumber,
            date: order.createdAt,
            status: order.status,
            direction: order.direction,
            party: order.party?.name,
            total: order.total,
            currency: order.currency,
            isCash: order.isCash,
            dueDate: order.dueDate,
          }));

    const content = this.toCsv(rows);
    const dateStamp = new Date().toISOString().slice(0, 10);

    return {
      fileName: `${type}_report_${dateStamp}.csv`,
      mimeType: 'text/csv; charset=utf-8',
      summary: report.summary,
      meta: report.meta,
      content,
    };
  }

  async getDueAccounts(businessId: string, query: any = {}) {
    const dueBefore = query.dueBefore ? new Date(query.dueBefore) : new Date();
    const includeFuture = query.includeFuture === 'true';

    const connections = await this.prisma.connection.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: businessId }, { receiverId: businessId }],
        account: {
          dueDate: includeFuture ? { not: null } : { lte: dueBefore },
          NOT: { balance: 0 },
        },
      },
      include: {
        requester: true,
        receiver: true,
        account: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    return connections.map((connection) => {
      const isRequester = connection.requesterId === businessId;
      const otherBusiness = isRequester
        ? connection.receiver
        : connection.requester;
      const balance = new Decimal((connection.account?.balance as any) || 0);
      const amountForMe = isRequester ? balance : balance.negated();

      return {
        connectionId: connection.id,
        businessId: otherBusiness.id,
        businessName: otherBusiness.name,
        dueDate: connection.account?.dueDate,
        billingCycle: connection.account?.billingCycle,
        balance: balance.toString(),
        amount: amountForMe.abs().toString(),
        direction: amountForMe.greaterThan(0) ? 'RECEIVABLE' : 'PAYABLE',
        isOverdue: connection.account?.dueDate
          ? connection.account.dueDate <= new Date()
          : false,
      };
    });
  }

  async getRecentActivity(businessId: string) {
    const [orders, transactions] = await Promise.all([
      this.prisma.order.findMany({
        where: { OR: [{ senderId: businessId }, { receiverId: businessId }] },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { sender: true, receiver: true },
      }),
      this.prisma.transaction.findMany({
        where: { OR: [{ senderId: businessId }, { receiverId: businessId }] },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { sender: true, receiver: true },
      }),
    ]);

    const activities = [
      ...orders.map((o) => ({
        id: o.id,
        type: 'ORDER',
        title: `طلبية ${o.senderId === businessId ? 'صادرة' : 'واردة'} #${o.orderNumber.slice(-4)}`,
        subtitle: o.senderId === businessId ? o.receiver.name : o.sender.name,
        amount: o.total.toString(),
        status: o.status,
        date: o.createdAt,
      })),
      ...transactions.map((t) => ({
        id: t.id,
        type: 'TRANSACTION',
        title: t.transactionType === 'PAYMENT' ? 'دفعة مالية' : 'حركة حساب',
        subtitle: t.senderId === businessId ? t.receiver.name : t.sender.name,
        amount: t.amount.toString(),
        status: 'COMPLETED',
        date: t.createdAt,
      })),
    ];

    return activities
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 10);
  }

  async getWeeklySalesData(businessId: string, query: any = {}) {
    const dateRange = this.resolveDateRange({
      period: query.period || 'week',
      ...query,
    });
    const startDate =
      dateRange?.gte ??
      (() => {
        const date = new Date();
        date.setDate(date.getDate() - 7);
        return date;
      })();

    const orders = await this.prisma.order.findMany({
      where: {
        receiverId: businessId, // Sales from this business's perspective (received orders)
        status: { in: ['COMPLETED', 'ACCEPTED'] },
        createdAt: dateRange ?? { gte: startDate },
      },
      select: {
        total: true,
        createdAt: true,
      },
    });

    const dailyData: Record<string, Decimal> = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayKey = d.toISOString().split('T')[0];
      dailyData[dayKey] = new Decimal(0);
    }

    orders.forEach((o) => {
      const dayKey = o.createdAt.toISOString().split('T')[0];
      if (dailyData[dayKey] !== undefined) {
        dailyData[dayKey] = dailyData[dayKey].plus(o.total as any);
      }
    });

    return Object.keys(dailyData)
      .sort()
      .map((date) => ({
        date,
        total: dailyData[date].toString(),
      }));
  }

  async getExpensesReport(businessId: string, query: any = {}) {
    const { page = 1, limit = 20 } = this.resolvePagination(query);
    const dateRange = this.resolveDateRange(query);
    const where: any = {
      businessId,
      ...(dateRange && { date: dateRange }),
    };

    const [expenses, total] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.expense.count({ where }),
    ]);

    const totalAmount = expenses.reduce(
      (sum, expense) => sum.plus(expense.amount as any),
      new Decimal(0),
    );

    return {
      data: expenses,
      summary: {
        count: expenses.length,
        totalAmount: totalAmount.toString(),
        period: this.describePeriod(query, dateRange),
      },
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
        limit,
      },
    };
  }

  private resolvePagination(query: any) {
    const page = Math.max(Number(query.page || 1), 1);
    const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
    return { page, limit };
  }

  private resolveDateRange(query: any) {
    if (query.startDate || query.endDate) {
      return {
        ...(query.startDate && { gte: new Date(query.startDate) }),
        ...(query.endDate && { lte: this.endOfDay(new Date(query.endDate)) }),
      };
    }

    if (!query.period) return undefined;

    const now = new Date();
    const start = new Date(now);

    switch (query.period) {
      case 'day':
        start.setHours(0, 0, 0, 0);
        break;
      case 'week':
        start.setDate(now.getDate() - 7);
        break;
      case 'month':
        start.setMonth(now.getMonth() - 1);
        break;
      case 'year':
        start.setFullYear(now.getFullYear() - 1);
        break;
      default:
        return undefined;
    }

    return { gte: start, lte: now };
  }

  private endOfDay(date: Date) {
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    return end;
  }

  private describePeriod(query: any, range?: { gte?: Date; lte?: Date }) {
    return {
      period: query.period ?? null,
      startDate: range?.gte?.toISOString() ?? query.startDate ?? null,
      endDate: range?.lte?.toISOString() ?? query.endDate ?? null,
    };
  }

  private toCsv(rows: Record<string, any>[]) {
    if (rows.length === 0) return '';

    const headers = Object.keys(rows[0]);
    const escape = (value: any) => {
      if (value === null || value === undefined) return '';
      const text = value instanceof Date ? value.toISOString() : String(value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    return [
      headers.join(','),
      ...rows.map((row) =>
        headers.map((header) => escape(row[header])).join(','),
      ),
    ].join('\n');
  }
}
