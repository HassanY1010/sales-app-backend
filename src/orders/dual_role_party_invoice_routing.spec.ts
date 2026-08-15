import { OrdersService } from './orders.service';
import { FinanceService } from '../finance/finance.service';
import { Decimal } from 'decimal.js';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

describe('Dual-Role Party Invoice Routing & Account Separation', () => {
  let ordersService: OrdersService;
  let financeService: FinanceService;

  // In-memory Database Store
  const store = {
    users: new Map<string, any>(),
    businesses: new Map<string, any>(),
    connections: new Map<string, any>(),
    accounts: new Map<string, any>(),
    orders: new Map<string, any>(),
    orderItems: new Map<string, any>(),
    transactions: new Map<string, any>(),
    invoiceSeq: 3000,
  };

  const mockPrisma: any = {
    $transaction: jest.fn(async (cb) => await cb(mockPrisma)),
    $executeRaw: jest.fn().mockResolvedValue(1),
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    notification: { create: jest.fn().mockResolvedValue({}) },
    connection: {
      findFirst: jest.fn(async ({ where }) => {
        const allowedStatuses = ['ACCEPTED', 'ACTIVE', 'accepted', 'active'];
        
        // Match by id
        if (where.id) {
          const conn = store.connections.get(where.id);
          if (!conn || !allowedStatuses.includes(conn.status)) return null;
          return { ...conn, account: store.accounts.get(conn.id) };
        }

        // Match by compound OR
        if (where.OR) {
          for (const orClause of where.OR) {
            for (const conn of store.connections.values()) {
              if (!allowedStatuses.includes(conn.status)) continue;
              const matchesReqRec =
                (conn.requesterId === orClause.requesterId && conn.receiverId === orClause.receiverId) ||
                (conn.requesterId === orClause.receiverId && conn.receiverId === orClause.requesterId);
              
              if (matchesReqRec) {
                if (orClause.connectionType) {
                  if (conn.requesterId === orClause.requesterId && conn.connectionType === orClause.connectionType) {
                    return { ...conn, account: store.accounts.get(conn.id) };
                  }
                  if (conn.receiverId === orClause.requesterId) {
                    const flippedType = conn.connectionType === 'CUSTOMER' ? 'SUPPLIER' : 'CUSTOMER';
                    if (flippedType === orClause.connectionType) {
                      return { ...conn, account: store.accounts.get(conn.id) };
                    }
                  }
                } else {
                  return { ...conn, account: store.accounts.get(conn.id) };
                }
              }
            }
          }
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
        if (where.OR) {
          for (const clause of where.OR) {
            if (clause.id && store.businesses.has(clause.id)) {
              const b = store.businesses.get(clause.id);
              return { ...b, user: store.users.get(b.userId) };
            }
            if (clause.userId) {
              for (const b of store.businesses.values()) {
                if (b.userId === clause.userId) return { ...b, user: store.users.get(b.userId) };
              }
            }
          }
        }
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
          status: data.status,
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
    customerSupplierLink: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  const mockEventsGateway: any = { emitToBusiness: jest.fn() };
  const mockNotificationsService: any = { sendPushNotification: jest.fn() };
  const mockInvoiceNumberService: any = {
    getNextInvoiceNumber: jest.fn().mockImplementation(async () => `INV-20260815-${++store.invoiceSeq}`),
  };

  beforeAll(() => {
    // 1. Setup Merchant and Dual Party
    store.users.set('user_merchant', { id: 'user_merchant', fullName: 'التاجر الرئيسي', userType: 'merchant' });
    store.businesses.set('biz_merchant', { id: 'biz_merchant', name: 'متجر التاجر', userId: 'user_merchant' });

    store.users.set('user_dual_party', { id: 'user_dual_party', fullName: 'أحمد للتجارة (عميل ومورد)', userType: 'merchant' });
    store.businesses.set('biz_dual_party', { id: 'biz_dual_party', name: 'مؤسسة أحمد', userId: 'user_dual_party' });

    // 2. Setup CUSTOMER Connection
    const custConnId = 'conn_customer_101';
    store.connections.set(custConnId, {
      id: custConnId,
      requesterId: 'biz_merchant',
      receiverId: 'biz_dual_party',
      connectionType: 'CUSTOMER',
      status: 'ACCEPTED',
      showPrices: true,
    });
    store.accounts.set(custConnId, {
      id: 'acc_customer_101',
      connectionId: custConnId,
      balance: new Decimal(0),
      totalDebit: new Decimal(0),
      totalCredit: new Decimal(0),
      creditLimit: new Decimal(100000),
      currency: 'YER',
    });

    // 3. Setup SUPPLIER Connection (Same Party!)
    const suppConnId = 'conn_supplier_202';
    store.connections.set(suppConnId, {
      id: suppConnId,
      requesterId: 'biz_merchant',
      receiverId: 'biz_dual_party',
      connectionType: 'SUPPLIER',
      status: 'ACCEPTED',
      showPrices: false,
    });
    store.accounts.set(suppConnId, {
      id: 'acc_supplier_202',
      connectionId: suppConnId,
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

  it('TEST 01: Cash Sale Invoice to Customer routes to Customer Account and leaves Supplier Account unchanged', async () => {
    const custAcc = store.accounts.get('conn_customer_101');
    const suppAcc = store.accounts.get('conn_supplier_202');
    const suppBalanceBefore = suppAcc.balance.toString();

    const order = await ordersService.createOrder('biz_merchant', {
      receiverId: 'biz_dual_party',
      connectionId: 'conn_customer_101',
      accountRole: 'CUSTOMER',
      isCash: true,
      pricesVisible: true,
      items: [{ itemName: 'بضاعة نقدية', quantity: 1, unitPrice: '500' }],
    }, 'merchant');

    expect(order.status).toBe('ISSUED');
    expect(order.connectionId).toBe('conn_customer_101');

    // Customer Account balance remains 0 net (since it was paid in cash), transactions were recorded under customer connection
    const txns = Array.from(store.transactions.values()).filter((t) => t.orderId === order.id);
    expect(txns.length).toBe(2); // SALE + PAYMENT
    for (const t of txns) {
      expect(t.connectionId).toBe('conn_customer_101'); // ONLY Customer Connection!
    }

    // Supplier Account is 100% UNCHANGED
    expect(suppAcc.balance.toString()).toBe(suppBalanceBefore);
  });

  it('TEST 02: Credit Sale Invoice to Customer increases Customer Debt and leaves Supplier Account unchanged', async () => {
    const custAcc = store.accounts.get('conn_customer_101');
    const suppAcc = store.accounts.get('conn_supplier_202');
    const suppBalanceBefore = suppAcc.balance.toString();
    const custDebitBefore = custAcc.totalDebit.toString();

    const order = await ordersService.createOrder('biz_merchant', {
      receiverId: 'biz_dual_party',
      connectionId: 'conn_customer_101',
      accountRole: 'CUSTOMER',
      isCash: false,
      pricesVisible: true,
      items: [{ itemName: 'بضاعة آجل', quantity: 2, unitPrice: '1000' }],
    }, 'merchant');

    expect(order.status).toBe('ISSUED');
    expect(order.total.toString()).toBe('2000');

    // Customer Account debit increased by 2000
    expect(custAcc.totalDebit.toString()).toBe(new Decimal(custDebitBefore).plus(2000).toString());

    // Verify transaction connectionId is Customer Connection
    const txns = Array.from(store.transactions.values()).filter((t) => t.orderId === order.id);
    expect(txns.length).toBe(1); // 1 SALE movement
    expect(txns[0].connectionId).toBe('conn_customer_101');

    // Supplier Account is 100% UNCHANGED
    expect(suppAcc.balance.toString()).toBe(suppBalanceBefore);
  });

  it('TEST 03: Purchase Order routes to Supplier Connection and leaves Customer Account unchanged', async () => {
    const custAcc = store.accounts.get('conn_customer_101');
    const custDebitBefore = custAcc.totalDebit.toString();

    const order = await ordersService.createOrder('biz_merchant', {
      receiverId: 'biz_dual_party',
      connectionId: 'conn_supplier_202',
      accountRole: 'SUPPLIER',
      notes: 'طلب توريد من التطبيق',
      pricesVisible: false,
      items: [{ itemName: 'مواد خام من المورد', quantity: 5, unitPrice: '0' }],
    }, 'merchant');

    expect(order.status).toBe('PENDING');
    expect(order.connectionId).toBe('conn_supplier_202');

    // Customer Account is 100% UNCHANGED
    expect(custAcc.totalDebit.toString()).toBe(custDebitBefore);
  });

  it('TEST 04: Wrong Connection Protection — SALE on Supplier Connection is REJECTED', async () => {
    await expect(
      ordersService.createOrder('biz_merchant', {
        receiverId: 'biz_dual_party',
        connectionId: 'conn_supplier_202', // SUPPLIER connection passed for a SALE
        accountRole: 'CUSTOMER',
        isCash: false,
        pricesVisible: true,
        items: [{ itemName: 'محاولة خاطئة', quantity: 1, unitPrice: '100' }],
      }, 'merchant')
    ).rejects.toThrow(/لا يمكن إنشاء فاتورة مبيعات على حساب مورد/);
  });

  it('TEST 05: Wrong Connection Protection — PURCHASE on Customer Connection is REJECTED', async () => {
    await expect(
      ordersService.createOrder('biz_merchant', {
        receiverId: 'biz_dual_party',
        connectionId: 'conn_customer_101', // CUSTOMER connection passed for a PURCHASE
        accountRole: 'SUPPLIER',
        notes: 'طلب توريد',
        pricesVisible: false,
        items: [{ itemName: 'محاولة خاطئة', quantity: 1, unitPrice: '0' }],
      }, 'merchant')
    ).rejects.toThrow(/لا يمكن إنشاء طلبية شراء على حساب عميل/);
  });

  it('TEST 06: Zero Duplicate Accounting Entries on Multiple Queries', async () => {
    const totalTxnsBefore = store.transactions.size;

    // Direct financial movement with explicit customer role
    await financeService.recordFinancialMovement(mockPrisma, {
      senderId: 'biz_merchant',
      receiverId: 'biz_dual_party',
      amount: '500',
      type: 'SALE',
      connectionId: 'conn_customer_101',
      accountRole: 'CUSTOMER',
    });

    const totalTxnsAfter = store.transactions.size;
    expect(totalTxnsAfter).toBe(totalTxnsBefore + 1); // Exactly 1 movement created!
  });
});
