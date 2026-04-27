import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import Decimal from 'decimal.js';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async getDebtsToMe(businessId: string) {
    // Other businesses owe me money
    const connections = await this.prisma.connection.findMany({
      where: {
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

  async getMyDebts(businessId: string) {
    // I owe money to other businesses
    const connections = await this.prisma.connection.findMany({
      where: {
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

  async getSummary(businessId: string) {
    // Basic dashboard summary stats
    const [orders, connections] = await Promise.all([
      this.prisma.order.findMany({
        where: { OR: [{ senderId: businessId }, { receiverId: businessId }] },
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
        if (o.senderId === businessId) totalPurchases = totalPurchases.plus(o.total as any);
        else totalSales = totalSales.plus(o.total as any);
      }
    });

    connections.forEach((c) => {
      const isRequester = c.requesterId === businessId;
      const balance = new Decimal(c.account?.balance as any || 0);
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
      customersCount: connections.filter((c) => c.connectionType === 'CUSTOMER').length,
      suppliersCount: connections.filter((c) => c.connectionType === 'SUPPLIER').length,
    };
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

    return activities.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 10);
  }

  async getWeeklySalesData(businessId: string) {
    const last7Days = new Date();
    last7Days.setDate(last7Days.getDate() - 7);

    const orders = await this.prisma.order.findMany({
      where: {
        receiverId: businessId, // Sales from this business's perspective (received orders)
        status: { in: ['COMPLETED', 'ACCEPTED'] },
        createdAt: { gte: last7Days },
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
}
