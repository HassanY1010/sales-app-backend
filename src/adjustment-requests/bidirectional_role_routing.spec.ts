import { Test, TestingModule } from '@nestjs/testing';
import { AdjustmentRequestsService } from './adjustment-requests.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../database/prisma.service';
import Decimal from 'decimal.js';

describe('Bidirectional Supplier <-> Customer Adjustment Notifications & Window Routing Spec', () => {
  let service: AdjustmentRequestsService;

  let dbBusinesses: any[] = [];
  let dbConnections: any[] = [];
  let dbAccounts: any[] = [];
  let dbTransactions: any[] = [];
  let dbOrders: any[] = [];
  let dbOrderItems: any[] = [];
  let dbAdjustmentRequests: any[] = [];
  let dbAuditLogs: any[] = [];
  let seq = 0;

  const mockNotificationsService = {
    notifyBusiness: jest.fn().mockResolvedValue(true),
    sendPushNotification: jest.fn().mockResolvedValue(true),
  };

  const mockEventsGateway = {
    emitToBusiness: jest.fn(),
  };

  const mockPrisma: any = {
    $transaction: jest.fn(async (cb) => cb(mockPrisma)),
    business: {
      findUnique: jest.fn(async ({ where }: any) => dbBusinesses.find((b) => b.id === where.id) || null),
    },
    connection: {
      findFirst: jest.fn(async ({ where }: any) => {
        return dbConnections.find((c) => {
          if (where.id && c.id === where.id) return true;
          if (where.OR) {
            return where.OR.some((cond: any) =>
              (cond.requesterId === c.requesterId && cond.receiverId === c.receiverId) ||
              (cond.requesterId === c.receiverId && cond.receiverId === c.requesterId)
            );
          }
          return false;
        }) || null;
      }),
      findUnique: jest.fn(async ({ where }: any) => dbConnections.find((c) => c.id === where.id) || null),
    },
    account: {
      findUnique: jest.fn(async ({ where }: any) => dbAccounts.find((a) => a.id === where.id) || null),
    },
    order: {
      findUnique: jest.fn(async ({ where, include, select }: any) => {
        const o = dbOrders.find((x) => x.id === where.id);
        if (!o) return null;
        const res = { ...o };
        if (include?.items) {
          res.items = dbOrderItems.filter((it) => it.orderId === o.id);
        }
        if (include?.connection || select?.connection) {
          res.connection = dbConnections.find((c) => c.id === o.connectionId) || null;
        }
        return res;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const o = dbOrders.find((x) => x.id === where.id);
        if (o) Object.assign(o, data);
        return o;
      }),
    },
    orderItem: {
      findMany: jest.fn(async () => dbOrderItems),
    },
    transaction: {
      findUnique: jest.fn(async ({ where, include, select }: any) => {
        const t = dbTransactions.find((x) => x.id === where.id);
        if (!t) return null;
        const res = { ...t };
        if (include?.connection || select?.connection) {
          res.connection = dbConnections.find((c) => c.id === t.connectionId) || null;
        }
        return res;
      }),
    },
    adjustmentRequest: {
      create: jest.fn(async ({ data }: any) => {
        const req = {
          id: `adj_${++seq}`,
          status: 'PENDING',
          createdAt: new Date(),
          ...data,
          requesterBusiness: dbBusinesses.find((b) => b.id === data.requesterBusinessId) || null,
          receiverBusiness: dbBusinesses.find((b) => b.id === data.receiverBusinessId) || null,
        };
        dbAdjustmentRequests.push(req);
        return req;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return dbAdjustmentRequests.find((r) => {
          if (where.targetType && r.targetType !== where.targetType) return false;
          if (where.targetId && r.targetId !== where.targetId) return false;
          if (where.status && r.status !== where.status) return false;
          return true;
        }) || null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return dbAdjustmentRequests.filter((r) => {
          if (where?.OR) {
            const matchesBiz = where.OR.some((cond: any) =>
              (cond.requesterBusinessId && r.requesterBusinessId === cond.requesterBusinessId) ||
              (cond.receiverBusinessId && r.receiverBusinessId === cond.receiverBusinessId)
            );
            if (!matchesBiz) return false;
          }
          if (where?.status && r.status !== where.status) return false;
          return true;
        });
      }),
      count: jest.fn(async () => dbAdjustmentRequests.length),
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        const log = { id: `log_${++seq}`, ...data };
        dbAuditLogs.push(log);
        return log;
      }),
    },
  };

  beforeEach(async () => {
    dbBusinesses = [
      { id: 'biz-merchant', name: 'أحمد (التاجر)' },
      { id: 'biz-supplier', name: 'علي (المورد)' },
      { id: 'biz-customer', name: 'محمد (العميل)' },
    ];

    dbConnections = [
      // 1. Connection between Merchant and Supplier: from Merchant perspective, this is a SUPPLIER connection.
      {
        id: 'conn-merchant-supplier',
        requesterId: 'biz-merchant',
        receiverId: 'biz-supplier',
        connectionType: 'SUPPLIER',
        status: 'ACCEPTED',
      },
      // 2. Connection between Merchant and Customer: from Merchant perspective, this is a CUSTOMER connection.
      {
        id: 'conn-merchant-customer',
        requesterId: 'biz-merchant',
        receiverId: 'biz-customer',
        connectionType: 'CUSTOMER',
        status: 'ACCEPTED',
      },
    ];

    dbAccounts = [];
    dbTransactions = [];
    dbOrders = [];
    dbOrderItems = [];
    dbAdjustmentRequests = [];
    dbAuditLogs = [];
    seq = 0;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdjustmentRequestsService,
        {
          provide: FinanceService,
          useValue: { rebuildAccountBalance: jest.fn() },
        },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    service = module.get<AdjustmentRequestsService>(AdjustmentRequestsService);
  });

  // ─────────────────────────────────────────────────────────────
  // SCENARIO 1: EDIT FROM SUPPLIERS WINDOW (الموردين -> العملاء)
  // ─────────────────────────────────────────────────────────────
  describe('Scenario 1: Edit from Suppliers Window (الموردين -> العملاء)', () => {
    it('When Merchant edits purchase order/voucher from Suppliers window, Supplier receives notification as CUSTOMER and targetRole in list is CUSTOMER (Customer Window)', async () => {
      // Setup purchase order from Merchant to Supplier
      dbOrders.push({
        id: 'order-po-1',
        orderNumber: 'PO-501',
        senderId: 'biz-merchant',
        receiverId: 'biz-supplier',
        connectionId: 'conn-merchant-supplier',
        total: '50000',
        subtotal: '50000',
        status: 'ISSUED',
        notes: 'طلب توريد من نافذة الموردين',
      });

      // Merchant creates adjustment request from Suppliers window
      const req = await service.create('biz-merchant', 'user-merchant', {
        targetType: 'ORDER',
        targetId: 'order-po-1',
        requestedAmount: '45000',
        reason: 'تعديل السعر المتفق عليه',
      });

      expect(req.status).toBe('PENDING');

      // Check Notification sent to Supplier:
      // Must be sent to Supplier ('biz-supplier')
      // Sender role seen by supplier must be 'العميل'
      // entityType / targetRole must be 'customer' / 'CUSTOMER'
      expect(mockNotificationsService.notifyBusiness).toHaveBeenCalledWith(
        'biz-supplier',
        expect.stringContaining('طلب تعديل'),
        expect.stringContaining('طلب العميل (أحمد (التاجر))'),
        expect.objectContaining({
          type: 'ADJUSTMENT_REQUEST_CREATED',
          notificationType: 'amendment_request_pending',
          entityType: 'customer',
          targetRole: 'CUSTOMER',
          senderRole: 'العميل',
        }),
      );

      // Check Supplier's list query:
      // When Supplier ('biz-supplier') loads adjustment requests list:
      // targetDetail.targetRole MUST be 'CUSTOMER' -> App counts badge in Customer Window!
      const supplierList = await service.list('biz-supplier', {});
      expect(supplierList.data.length).toBe(1);
      expect(supplierList.data[0].targetDetail.targetRole).toBe('CUSTOMER');
    });

    it('When Merchant edits payment voucher to Supplier, Supplier receives notification as CUSTOMER and targetRole is CUSTOMER', async () => {
      dbTransactions.push({
        id: 'txn-supp-pay-1',
        voucherNumber: 'VOUCHER-SUPP-1',
        senderId: 'biz-merchant',
        receiverId: 'biz-supplier',
        connectionId: 'conn-merchant-supplier',
        amount: '20000',
        transactionType: 'PAYMENT',
      });

      await service.create('biz-merchant', 'user-merchant', {
        targetType: 'TRANSACTION',
        targetId: 'txn-supp-pay-1',
        requestedAmount: '22000',
        reason: 'تصحيح مبلغ سند الصرف',
      });

      expect(mockNotificationsService.notifyBusiness).toHaveBeenCalledWith(
        'biz-supplier',
        expect.stringContaining('طلب تعديل'),
        expect.stringContaining('طلب العميل (أحمد (التاجر))'),
        expect.objectContaining({
          entityType: 'customer',
          targetRole: 'CUSTOMER',
        }),
      );

      const supplierList = await service.list('biz-supplier', {});
      expect(supplierList.data[0].targetDetail.targetRole).toBe('CUSTOMER');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // SCENARIO 2: EDIT FROM CUSTOMERS WINDOW (العملاء -> الموردين)
  // ─────────────────────────────────────────────────────────────
  describe('Scenario 2: Edit from Customers Window (العملاء -> الموردين)', () => {
    it('When Merchant edits sales invoice/voucher from Customers window, Customer receives notification as SUPPLIER and targetRole in list is SUPPLIER (Suppliers Window)', async () => {
      // Setup sales invoice from Merchant to Customer
      dbOrders.push({
        id: 'order-inv-1',
        orderNumber: 'INV-1001',
        senderId: 'biz-merchant',
        receiverId: 'biz-customer',
        connectionId: 'conn-merchant-customer',
        total: '30000',
        subtotal: '30000',
        status: 'ISSUED',
      });

      // Merchant creates adjustment request from Customers window
      const req = await service.create('biz-merchant', 'user-merchant', {
        targetType: 'ORDER',
        targetId: 'order-inv-1',
        requestedAmount: '28000',
        reason: 'خصم إضافي للعميل',
      });

      expect(req.status).toBe('PENDING');

      // Check Notification sent to Customer:
      // Must be sent to Customer ('biz-customer')
      // Sender role seen by customer must be 'المورد'
      // entityType / targetRole must be 'supplier' / 'SUPPLIER'
      expect(mockNotificationsService.notifyBusiness).toHaveBeenCalledWith(
        'biz-customer',
        expect.stringContaining('طلب تعديل'),
        expect.stringContaining('طلب المورد (أحمد (التاجر))'),
        expect.objectContaining({
          type: 'ADJUSTMENT_REQUEST_CREATED',
          notificationType: 'amendment_request_pending',
          entityType: 'supplier',
          targetRole: 'SUPPLIER',
          senderRole: 'المورد',
        }),
      );

      // Check Customer's list query:
      // When Customer ('biz-customer') loads adjustment requests list:
      // targetDetail.targetRole MUST be 'SUPPLIER' -> App counts badge in Suppliers Window!
      const customerList = await service.list('biz-customer', {});
      expect(customerList.data.length).toBe(1);
      expect(customerList.data[0].targetDetail.targetRole).toBe('SUPPLIER');
    });

    it('When Merchant edits receipt voucher from Customer, Customer receives notification as SUPPLIER and targetRole is SUPPLIER', async () => {
      dbTransactions.push({
        id: 'txn-cust-rec-1',
        voucherNumber: 'REC-CUST-1',
        senderId: 'biz-customer',
        receiverId: 'biz-merchant',
        connectionId: 'conn-merchant-customer',
        amount: '15000',
        transactionType: 'PAYMENT',
      });

      await service.create('biz-merchant', 'user-merchant', {
        targetType: 'TRANSACTION',
        targetId: 'txn-cust-rec-1',
        requestedAmount: '16000',
        reason: 'تصحيح مبلغ سند القبض',
      });

      expect(mockNotificationsService.notifyBusiness).toHaveBeenCalledWith(
        'biz-customer',
        expect.stringContaining('طلب تعديل'),
        expect.stringContaining('طلب المورد (أحمد (التاجر))'),
        expect.objectContaining({
          entityType: 'supplier',
          targetRole: 'SUPPLIER',
        }),
      );

      const customerList = await service.list('biz-customer', {});
      expect(customerList.data[0].targetDetail.targetRole).toBe('SUPPLIER');
    });
  });
});
