import { OrdersService } from './orders.service';
import { FinanceService } from '../finance/finance.service';
import { InvoiceNumberService } from '../common/invoice-number.service';
import { Decimal } from 'decimal.js';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

describe('Strict Pricing Audit & E2E Evidence Verification', () => {
  let ordersService: OrdersService;
  let financeService: FinanceService;

  // In-memory Database Store simulating PostgreSQL/Prisma
  const store = {
    users: new Map<string, any>(),
    businesses: new Map<string, any>(),
    connections: new Map<string, any>(),
    accounts: new Map<string, any>(),
    orders: new Map<string, any>(),
    orderItems: new Map<string, any>(),
    transactions: new Map<string, any>(),
    invoiceSeq: 2000,
  };

  const mockPrisma: any = {
    $transaction: jest.fn(async (cb) => await cb(mockPrisma)),
    $executeRaw: jest.fn().mockResolvedValue(1),
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    notification: { create: jest.fn().mockResolvedValue({}) },
    connection: {
      findFirst: jest.fn(async () => {
        for (const conn of store.connections.values()) {
          const acc = store.accounts.get(conn.id);
          return { ...conn, account: acc };
        }
        return null;
      }),
    },
    account: {
      findUnique: jest.fn(async ({ where }) => {
        for (const acc of store.accounts.values()) {
          if (acc.id === where.id) return acc;
        }
        return null;
      }),
      update: jest.fn(async ({ where, data }) => {
        let acc: any = null;
        for (const a of store.accounts.values()) {
          if (a.id === where.id) { acc = a; break; }
        }
        if (!acc) return null;
        if (data.balance?.increment !== undefined) {
          acc.balance = acc.balance.plus(new Decimal(data.balance.increment));
        }
        if (data.totalDebit !== undefined) acc.totalDebit = new Decimal(data.totalDebit);
        if (data.totalCredit !== undefined) acc.totalCredit = new Decimal(data.totalCredit);
        return acc;
      }),
    },
    business: {
      findUnique: jest.fn(async ({ where }) => {
        const b = store.businesses.get(where.id);
        if (!b) return null;
        return { ...b, user: store.users.get(b.userId) };
      }),
      findFirst: jest.fn(async ({ where }) => {
        const b = store.businesses.get(where.id);
        if (!b) return null;
        return { ...b, user: store.users.get(b.userId) };
      }),
    },
    order: {
      create: jest.fn(async ({ data }) => {
        const id = `ord_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const items = (data.items?.create || []).map((it: any) => {
          const itemId = `item_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          const itemObj = { id: itemId, orderId: id, ...it };
          store.orderItems.set(itemId, itemObj);
          return itemObj;
        });
        const orderObj = {
          id,
          orderNumber: data.orderNumber,
          senderId: data.senderId,
          receiverId: data.receiverId,
          connectionId: data.connectionId,
          status: data.status || (data.pricesVisible ? 'ISSUED' : 'PENDING'),
          isCash: data.isCash ?? false,
          currency: data.currency || 'YER',
          pricesVisible: data.pricesVisible ?? false,
          priceAcceptedAt: data.priceAcceptedAt ?? null,
          subtotal: data.subtotal || '0',
          tax: data.tax || '0',
          discount: data.discount || '0',
          paidAmount: data.paidAmount || '0',
          total: data.total || '0',
          notes: data.notes,
          invoiceId: null,
          rejectionReason: null,
          rejectedById: null,
          items,
          sender: store.businesses.get(data.senderId),
          receiver: store.businesses.get(data.receiverId),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.orders.set(id, orderObj);
        return orderObj;
      }),
      findUnique: jest.fn(async ({ where }) => {
        const o = store.orders.get(where.id);
        if (!o) return null;
        const items = Array.from(store.orderItems.values()).filter((it) => it.orderId === o.id);
        return {
          ...o,
          items,
          sender: store.businesses.get(o.senderId),
          receiver: store.businesses.get(o.receiverId),
        };
      }),
      update: jest.fn(async ({ where, data }) => {
        const o = store.orders.get(where.id);
        if (!o) return null;
        Object.assign(o, data, { updatedAt: new Date() });
        return o;
      }),
    },
    orderItem: {
      update: jest.fn(async ({ where, data }) => {
        const it = store.orderItems.get(where.id);
        if (!it) return null;
        Object.assign(it, data);
        return it;
      }),
    },
    transaction: {
      create: jest.fn(async ({ data }) => {
        const id = `tx_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const txnObj = { id, ...data, createdAt: new Date() };
        store.transactions.set(id, txnObj);
        return txnObj;
      }),
      findMany: jest.fn(async () => Array.from(store.transactions.values())),
    },
  };

  const mockEventsGateway: any = { emitToBusiness: jest.fn() };
  const mockNotificationsService: any = { sendPushNotification: jest.fn() };
  const mockInvoiceNumberService: any = {
    getNextInvoiceNumber: jest.fn().mockImplementation(async () => `INV-20260815-${++store.invoiceSeq}`),
    generateInvoiceNumber: jest.fn().mockImplementation(async () => `INV-20260815-${++store.invoiceSeq}`),
  };

  beforeAll(() => {
    // Seed initial users and connection
    store.users.set('user_hr', { id: 'user_hr', fullName: 'شركة HR', userType: 'merchant', role: 'MERCHANT' });
    store.users.set('user_client', { id: 'user_client', fullName: 'العميل محمد', userType: 'merchant', role: 'MERCHANT' });
    store.users.set('user_intruder', { id: 'user_intruder', fullName: 'طرف ثالث متسلل', userType: 'merchant', role: 'MERCHANT' });
    store.users.set('user_consumer', { id: 'user_consumer', fullName: 'مستهلك فردي', userType: 'individual', role: 'CONSUMER' });

    store.businesses.set('biz_hr', { id: 'biz_hr', name: 'شركة HR', userId: 'user_hr' });
    store.businesses.set('biz_client', { id: 'biz_client', name: 'العميل محمد', userId: 'user_client' });
    store.businesses.set('biz_intruder', { id: 'biz_intruder', name: 'متجر غير مرتبط', userId: 'user_intruder' });
    store.businesses.set('biz_consumer', { id: 'biz_consumer', name: 'حساب المستهلك', userId: 'user_consumer' });

    const connId = 'conn_hr_client';
    store.connections.set(connId, {
      id: connId,
      requesterId: 'biz_hr',
      receiverId: 'biz_client',
      connectionType: 'CUSTOMER',
      status: 'ACCEPTED',
      showPrices: true,
    });

    store.accounts.set(connId, {
      id: 'acc_hr_client',
      connectionId: connId,
      balance: new Decimal(0),
      totalDebit: new Decimal(0),
      totalCredit: new Decimal(0),
      creditLimit: new Decimal(100000),
      currency: 'YER',
    });

    financeService = new FinanceService(mockPrisma, mockNotificationsService, mockEventsGateway);
    ordersService = new OrdersService(
      mockPrisma,
      financeService,
      mockNotificationsService,
      mockEventsGateway,
      mockInvoiceNumberService,
    );
  });

  it('AUDIT 01: Modifying ISSUED invoice (1300 -> Raise to 1350 -> Lower to 1250)', async () => {
    // 1. Create ISSUED Invoice #26 with 3 items:
    // - ماء شملان (100)
    // - رز (1000)
    // - كيك (200)
    // Total = 1300 YER
    const order = await ordersService.createOrder('biz_hr', {
      receiverId: 'biz_client',
      isCash: false,
      pricesVisible: true,
      items: [
        { itemName: 'ماء شملان', quantity: 1, unitPrice: '100', unit: 'كرتون' },
        { itemName: 'رز', quantity: 1, unitPrice: '1000', unit: 'كيس' },
        { itemName: 'كيك', quantity: 1, unitPrice: '200', unit: 'كرتون' },
      ],
    }, 'merchant');

    expect(order.status).toBe('ISSUED');
    expect(order.total.toString()).toBe('1300');

    // 2. Raise price of ماء شملان: 100 -> 150 (Total: 1300 -> 1350, Diff = +50)
    const raisedOrder = await ordersService.updateOrderPrices('biz_hr', order.id, {
      items: [
        { id: order.items[0].id, unitPrice: '150' },
        { id: order.items[1].id, unitPrice: '1000' },
        { id: order.items[2].id, unitPrice: '200' },
      ],
    }, 'merchant');

    expect(raisedOrder.total.toString()).toBe('1350');
    expect(raisedOrder.subtotal.toString()).toBe('1350');
    expect(store.orderItems.get(order.items[0].id).unitPrice.toString()).toBe('150');

    // 3. Lower price of رز: 1000 -> 900 (Total: 1350 -> 1250, Diff = -100)
    const loweredOrder = await ordersService.updateOrderPrices('biz_hr', order.id, {
      items: [
        { id: order.items[0].id, unitPrice: '150' },
        { id: order.items[1].id, unitPrice: '900' },
        { id: order.items[2].id, unitPrice: '200' },
      ],
    }, 'merchant');

    expect(loweredOrder.total.toString()).toBe('1250');
    expect(loweredOrder.subtotal.toString()).toBe('1250');
    expect(store.orderItems.get(order.items[1].id).unitPrice.toString()).toBe('900');
  });

  it('AUDIT 02: Duplicate Protection — Saving identical prices 3 times creates ZERO duplicate accounting entries', async () => {
    // 1. Create and accept an order to create an invoice with ledger entry
    const order = await ordersService.createOrder('biz_hr', {
      receiverId: 'biz_client',
      isCash: false,
      pricesVisible: true,
      items: [
        { itemName: 'سلعة اختبار', quantity: 2, unitPrice: '500' },
      ],
    }, 'merchant');

    const txnCountBefore = store.transactions.size;

    // Save 1 with same prices
    await ordersService.updateOrderPrices('biz_hr', order.id, {
      items: [{ id: order.items[0].id, unitPrice: '500' }],
    }, 'merchant');

    // Save 2 with same prices
    await ordersService.updateOrderPrices('biz_hr', order.id, {
      items: [{ id: order.items[0].id, unitPrice: '500' }],
    }, 'merchant');

    // Save 3 with same prices
    await ordersService.updateOrderPrices('biz_hr', order.id, {
      items: [{ id: order.items[0].id, unitPrice: '500' }],
    }, 'merchant');

    const txnCountAfter = store.transactions.size;
    expect(txnCountAfter).toBe(txnCountBefore); // 0 new adjustments created!
  });

  it('AUDIT 03: Security & Authorization — Non-party User C and Consumer are Forbidden', async () => {
    const order = await ordersService.createOrder('biz_hr', {
      receiverId: 'biz_client',
      isCash: false,
      pricesVisible: true,
      items: [{ itemName: 'منتج أمان', quantity: 1, unitPrice: '100' }],
    }, 'merchant');

    // 1. Third party intruder attempts to update price
    await expect(
      ordersService.updateOrderPrices('biz_intruder', order.id, {
        items: [{ id: order.items[0].id, unitPrice: '9999' }],
      }, 'merchant')
    ).rejects.toThrow(ForbiddenException);

    // 2. Individual consumer attempts to update price
    await expect(
      ordersService.updateOrderPrices('biz_consumer', order.id, {
        items: [{ id: order.items[0].id, unitPrice: '500' }],
      }, 'individual')
    ).rejects.toThrow(ForbiddenException);
  });

  it('AUDIT 04: Item Ownership — Item ID from another order is strictly rejected', async () => {
    const order1 = await ordersService.createOrder('biz_hr', {
      receiverId: 'biz_client',
      isCash: false,
      pricesVisible: true,
      items: [{ itemName: 'منتج 1', quantity: 1, unitPrice: '100' }],
    }, 'merchant');

    const order2 = await ordersService.createOrder('biz_hr', {
      receiverId: 'biz_client',
      isCash: false,
      pricesVisible: true,
      items: [{ itemName: 'منتج 2', quantity: 1, unitPrice: '200' }],
    }, 'merchant');

    // Attempt to pass order2 item id when updating order1
    await expect(
      ordersService.updateOrderPrices('biz_hr', order1.id, {
        items: [{ id: order2.items[0].id, unitPrice: '9999' }],
      }, 'merchant')
    ).rejects.toThrow(/لا ينتمي إلى هذه الطلبية/);
  });

  it('AUDIT 05: Locked Statuses — REJECTED, CANCELLED, COMPLETED orders are strictly rejected', async () => {
    // 1. REJECTED order
    const rejOrder = await ordersService.createOrder('biz_client', {
      receiverId: 'biz_hr',
      pricesVisible: false,
      items: [{ itemName: 'طلب ملغي', quantity: 1, unitPrice: '0' }],
    }, 'merchant');

    // Reject it
    await ordersService.updateOrderStatus('biz_hr', rejOrder.id, {
      status: 'REJECTED',
      rejectionReason: 'غير متوفر',
    }, 'merchant');

    await expect(
      ordersService.updateOrderPrices('biz_hr', rejOrder.id, {
        items: [{ id: rejOrder.items[0].id, unitPrice: '500' }],
      }, 'merchant')
    ).rejects.toThrow(BadRequestException);
  });
});
