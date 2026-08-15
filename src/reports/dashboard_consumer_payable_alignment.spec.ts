import { ReportsService } from './reports.service';
import { Decimal } from 'decimal.js';

describe('Dashboard "عليك" (Payable) & Supplier Reports Exact Accounting Alignment', () => {
  let reportsService: ReportsService;

  const store = {
    connections: new Map<string, any>(),
    accounts: new Map<string, any>(),
    orders: new Map<string, any>(),
    businesses: new Map<string, any>(),
  };

  const mockPrisma: any = {
    connection: {
      findMany: jest.fn(async ({ where }) => {
        const res: any[] = [];
        for (const conn of store.connections.values()) {
          if (where.status && conn.status !== where.status) continue;
          if (where.OR) {
            const matches = where.OR.some(
              (o: any) =>
                (o.requesterId && conn.requesterId === o.requesterId) ||
                (o.receiverId && conn.receiverId === o.receiverId) ||
                (o.requesterId && conn.receiverId === o.requesterId) ||
                (o.receiverId && conn.requesterId === o.receiverId),
            );
            if (!matches) continue;
          }
          const account = store.accounts.get(conn.id);
          const requester = store.businesses.get(conn.requesterId);
          const receiver = store.businesses.get(conn.receiverId);
          res.push({ ...conn, account, requester, receiver });
        }
        return res;
      }),
    },
    order: {
      findMany: jest.fn(async ({ where }) => {
        return Array.from(store.orders.values());
      }),
    },
  };

  beforeAll(() => {
    reportsService = new ReportsService(mockPrisma);
  });

  beforeEach(() => {
    store.connections.clear();
    store.accounts.clear();
    store.orders.clear();
    store.businesses.clear();

    // Consumer Business Entity
    store.businesses.set('biz_consumer', { id: 'biz_consumer', name: 'المستهلك ABCD', businessType: 'مستخدم شخصي' });

    // Supplier A
    store.businesses.set('biz_supp_a', { id: 'biz_supp_a', name: 'محلات اليمامة', businessType: 'تاجر' });

    // Supplier B
    store.businesses.set('biz_supp_b', { id: 'biz_supp_b', name: 'شركة البركة', businessType: 'تاجر' });

    // Supplier C
    store.businesses.set('biz_supp_c', { id: 'biz_supp_c', name: 'مؤسسة النور', businessType: 'تاجر' });

    // Customer X
    store.businesses.set('biz_cust_x', { id: 'biz_cust_x', name: 'العميل خالد', businessType: 'مستخدم شخصي' });
  });

  it('TEST 01: Single Supplier with 9,500 YER debt -> Supplier Reports and Dashboard are 100% equal (9,500 YER)', async () => {
    // Consumer linked to Supplier A (Consumer is requester, connectionType is SUPPLIER)
    const connId = 'conn_supp_a';
    store.connections.set(connId, {
      id: connId,
      requesterId: 'biz_consumer',
      receiverId: 'biz_supp_a',
      connectionType: 'SUPPLIER',
      status: 'ACCEPTED',
    });
    store.accounts.set(connId, {
      id: 'acc_supp_a',
      connectionId: connId,
      balance: new Decimal(9500), // balance > 0 means consumer owes supplier 9,500 YER
      totalDebit: new Decimal(9500),
      totalCredit: new Decimal(0),
    });

    // 1. Supplier Reports (getMyDebts)
    const debtsReport = await reportsService.getMyDebts('biz_consumer');
    expect(debtsReport.length).toBe(1);
    expect(debtsReport[0].businessName).toBe('محلات اليمامة');
    expect(debtsReport[0].amount).toBe('9500');

    // 2. Dashboard Summary (getSummary)
    const summary = await reportsService.getSummary('biz_consumer');
    expect(summary.payable).toBe('9500');
    expect(summary.receivable).toBe('0');

    // 3. Exact Equality Check
    const totalFromReport = debtsReport.reduce((acc, d) => acc.plus(new Decimal(d.amount)), new Decimal(0));
    expect(new Decimal(summary.payable).equals(totalFromReport)).toBe(true);
  });

  it('TEST 02: Partial Payment of 2,500 YER -> Remaining Debt = 7,000 YER on both Dashboard and Supplier Reports', async () => {
    const connId = 'conn_supp_a';
    store.connections.set(connId, {
      id: connId,
      requesterId: 'biz_consumer',
      receiverId: 'biz_supp_a',
      connectionType: 'SUPPLIER',
      status: 'ACCEPTED',
    });
    // Balance drops from 9,500 to 7,000
    store.accounts.set(connId, {
      id: 'acc_supp_a',
      connectionId: connId,
      balance: new Decimal(7000),
      totalDebit: new Decimal(9500),
      totalCredit: new Decimal(2500),
    });

    const debtsReport = await reportsService.getMyDebts('biz_consumer');
    const summary = await reportsService.getSummary('biz_consumer');

    expect(debtsReport[0].amount).toBe('7000');
    expect(summary.payable).toBe('7000');
    expect(summary.receivable).toBe('0');
  });

  it('TEST 03: Full Repayment of 7,000 YER -> Debt = 0 YER on both Dashboard and Supplier Reports', async () => {
    const connId = 'conn_supp_a';
    store.connections.set(connId, {
      id: connId,
      requesterId: 'biz_consumer',
      receiverId: 'biz_supp_a',
      connectionType: 'SUPPLIER',
      status: 'ACCEPTED',
    });
    // Balance drops to 0
    store.accounts.set(connId, {
      id: 'acc_supp_a',
      connectionId: connId,
      balance: new Decimal(0),
      totalDebit: new Decimal(9500),
      totalCredit: new Decimal(9500),
    });

    const debtsReport = await reportsService.getMyDebts('biz_consumer');
    const summary = await reportsService.getSummary('biz_consumer');

    expect(debtsReport.length).toBe(0);
    expect(summary.payable).toBe('0');
    expect(summary.receivable).toBe('0');
  });

  it('TEST 04: Multiple Suppliers (A: 9,500, B: 3,000, C: 1,500) -> Total = 14,000 YER on both Dashboard and Reports', async () => {
    // Supplier A: 9,500
    store.connections.set('conn_a', {
      id: 'conn_a',
      requesterId: 'biz_consumer',
      receiverId: 'biz_supp_a',
      connectionType: 'SUPPLIER',
      status: 'ACCEPTED',
    });
    store.accounts.set('conn_a', { id: 'acc_a', balance: new Decimal(9500) });

    // Supplier B: 3,000
    store.connections.set('conn_b', {
      id: 'conn_b',
      requesterId: 'biz_consumer',
      receiverId: 'biz_supp_b',
      connectionType: 'SUPPLIER',
      status: 'ACCEPTED',
    });
    store.accounts.set('conn_b', { id: 'acc_b', balance: new Decimal(3000) });

    // Supplier C: 1,500
    store.connections.set('conn_c', {
      id: 'conn_c',
      requesterId: 'biz_consumer',
      receiverId: 'biz_supp_c',
      connectionType: 'SUPPLIER',
      status: 'ACCEPTED',
    });
    store.accounts.set('conn_c', { id: 'acc_c', balance: new Decimal(1500) });

    const debtsReport = await reportsService.getMyDebts('biz_consumer');
    const summary = await reportsService.getSummary('biz_consumer');

    expect(debtsReport.length).toBe(3);
    const totalFromReport = debtsReport.reduce((acc, d) => acc.plus(new Decimal(d.amount)), new Decimal(0));
    expect(totalFromReport.toString()).toBe('14000');
    expect(summary.payable).toBe('14000');
    expect(summary.suppliersCount).toBe(3);
  });

  it('TEST 05: Concurrent Customer Debt (Receivable: 5,000) & Supplier Debt (Payable: 9,500) -> Strict Separation', async () => {
    // Supplier A (I owe them 9,500)
    store.connections.set('conn_supp_a', {
      id: 'conn_supp_a',
      requesterId: 'biz_consumer',
      receiverId: 'biz_supp_a',
      connectionType: 'SUPPLIER',
      status: 'ACCEPTED',
    });
    store.accounts.set('conn_supp_a', { id: 'acc_supp_a', balance: new Decimal(9500) });

    // Customer X (They owe me 5,000)
    store.connections.set('conn_cust_x', {
      id: 'conn_cust_x',
      requesterId: 'biz_consumer',
      receiverId: 'biz_cust_x',
      connectionType: 'CUSTOMER',
      status: 'ACCEPTED',
    });
    store.accounts.set('conn_cust_x', { id: 'acc_cust_x', balance: new Decimal(5000) });

    const debtsToMeReport = await reportsService.getDebtsToMe('biz_consumer');
    const myDebtsReport = await reportsService.getMyDebts('biz_consumer');
    const summary = await reportsService.getSummary('biz_consumer');

    // "لك" (مستحقات)
    expect(debtsToMeReport.length).toBe(1);
    expect(debtsToMeReport[0].amount).toBe('5000');
    expect(summary.receivable).toBe('5000');

    // "عليك" (ديون)
    expect(myDebtsReport.length).toBe(1);
    expect(myDebtsReport[0].amount).toBe('9500');
    expect(summary.payable).toBe('9500');

    // Strict non-leakage
    expect(summary.payable).not.toBe(summary.receivable);
  });
});
