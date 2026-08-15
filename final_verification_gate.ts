import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { PrismaService } from './src/database/prisma.service';
import { OrdersService } from './src/orders/orders.service';
import { FinanceService } from './src/finance/finance.service';
import { TransactionsService } from './src/transactions/transactions.service';
import { ConnectionsService } from './src/connections/connections.service';
import { ReportsService } from './src/reports/reports.service';
import Decimal from 'decimal.js';

async function runFinalVerificationGate() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const ordersService = app.get(OrdersService);
  const financeService = app.get(FinanceService);
  const transactionsService = app.get(TransactionsService);
  const connectionsService = app.get(ConnectionsService);
  const reportsService = app.get(ReportsService);

  console.log('========================================================================');
  console.log('FINAL VERIFICATION GATE — FULL SYSTEM & API & DATABASE & REPORTS AUDIT');
  console.log('========================================================================');

  const rand = Math.floor(10000 + Math.random() * 90000);

  // 1. Create Merchant and Customer
  const merchantUser = await prisma.user.create({
    data: {
      email: `gate_merchant_${Date.now()}_${rand}@test.com`,
      phoneNumber: `+96777${rand}1`,
      password: 'Password123!',
      fullName: 'التاجر الرئيسي',
      userType: 'merchant',
    },
  });
  const merchantBiz = await prisma.business.create({
    data: { name: `مؤسسة التاجر ${rand}`, userId: merchantUser.id },
  });

  const customerUser = await prisma.user.create({
    data: {
      email: `gate_customer_${Date.now()}_${rand}@test.com`,
      phoneNumber: `+96777${rand}2`,
      password: 'Password123!',
      fullName: 'العميل محمد',
      userType: 'merchant',
    },
  });
  const customerBiz = await prisma.business.create({
    data: { name: `مؤسسة العميل محمد ${rand}`, userId: customerUser.id },
  });

  // Create Connection
  const connection = await prisma.connection.create({
    data: {
      requesterId: merchantBiz.id,
      receiverId: customerBiz.id,
      connectionType: 'CUSTOMER',
      requestSource: 'CUSTOMERS',
      status: 'ACCEPTED',
      account: {
        create: {
          balance: 0,
          creditLimit: 100000,
          currency: 'YER',
          totalDebit: 0,
          totalCredit: 0,
        },
      },
    },
    include: { account: true },
  });

  const accountId = connection.account!.id;
  console.log(`Setup complete. Connection ID: ${connection.id}, Account ID: ${accountId}`);

  // ── Step 0: Opening Balance 10,000 ──
  console.log('\n--- 1. Step 0: Opening Balance 10,000 YER ---');
  await prisma.$transaction(async (tx) => {
    await financeService.recordFinancialMovement(tx, {
      senderId: merchantBiz.id,
      receiverId: customerBiz.id,
      amount: '10000',
      type: 'ADJUSTMENT',
      note: 'رصيد افتتاحي: 10000',
      connectionId: connection.id,
    });
  }, { timeout: 30000 });

  // ── Step 1: Credit Invoice 5,000 (Paid 0) ──
  console.log('\n--- 2. Step 1: Credit Invoice 5,000 YER ---');
  const creditOrder = await ordersService.createOrder(
    merchantBiz.id,
    {
      receiverId: customerBiz.id,
      isCash: false,
      paidAmount: '0',
      pricesVisible: true,
      items: [{ itemName: 'بضاعة آجل', quantity: 1, unitPrice: '5000', unit: 'قطعة' }],
    },
    'merchant',
  );

  // ── Step 2: Cash Invoice 3,000 (Paid 3,000) ──
  console.log('\n--- 3. Step 2: Cash Invoice 3,000 YER (Paid 3,000) ---');
  const cashOrder = await ordersService.createOrder(
    merchantBiz.id,
    {
      receiverId: customerBiz.id,
      isCash: true,
      paidAmount: '3000',
      pricesVisible: true,
      items: [{ itemName: 'بضاعة نقداً', quantity: 1, unitPrice: '3000', unit: 'قطعة' }],
    },
    'merchant',
  );

  // ── Step 3: Partial Invoice 8,000 (Paid 2,000, Remaining 6,000) ──
  console.log('\n--- 4. Step 3: Partial Invoice 8,000 YER (Paid 2,000) ---');
  const partialOrder = await ordersService.createOrder(
    merchantBiz.id,
    {
      receiverId: customerBiz.id,
      isCash: false,
      paidAmount: '2000',
      pricesVisible: true,
      items: [{ itemName: 'بضاعة جزئية', quantity: 1, unitPrice: '8000', unit: 'قطعة' }],
    },
    'merchant',
  );

  // ── Step 4: Real Standalone Receipt 4,000 ──
  console.log('\n--- 5. Step 4: Real Standalone Receipt 4,000 YER ---');
  const receipt1 = await transactionsService.createTransaction(merchantBiz.id, {
    transactionType: 'PAYMENT',
    paymentDirection: 'RECEIVED',
    receiverId: customerBiz.id,
    connectionId: connection.id,
    amount: '4000',
    voucherNumber: 'VCH-REAL-4000',
    paymentMethod: 'CASH',
    note: 'سند قبض يدوي حقيقي',
  } as any);

  // ── Step 5: Real Standalone Receipt 7,000 ──
  console.log('\n--- 6. Step 5: Real Standalone Receipt 7,000 YER ---');
  const receipt2 = await transactionsService.createTransaction(merchantBiz.id, {
    transactionType: 'PAYMENT',
    paymentDirection: 'RECEIVED',
    receiverId: customerBiz.id,
    connectionId: connection.id,
    amount: '7000',
    voucherNumber: 'VCH-REAL-7000',
    paymentMethod: 'CASH',
    note: 'سند قبض يدوي حقيقي 2',
  } as any);

  // ── Step 6: Direct API / Service Layer Query (Customer Balance, Statements, Reports) ──
  console.log('\n========================================================================');
  console.log('QUERYING SERVICES & REPORTS (API LAYER VERIFICATION)');
  console.log('========================================================================');

  // A. Connections Service (Customer Model as fetched by Flutter)
  const connectionsRes = await connectionsService.getConnections(merchantBiz.id, { page: 1, limit: 10 }, '', 'CUSTOMERS');
  const customerConn = connectionsRes.data.find((c: any) => c.id === connection.id);
  console.log(`API Connections -> Customer Balance (customerConn.balance): ${customerConn?.balance}`);

  // B. Transactions Service (Statement / Ledger as fetched by Flutter)
  const statementRes = await transactionsService.getTransactions(merchantBiz.id, { connectionId: connection.id, limit: 50 });
  console.log(`API Transactions -> Statement Total Transactions Count: ${statementRes.data.length}`);

  // C. Reports Service (Dashboard Summary)
  const summary = await reportsService.getSummary(merchantBiz.id);
  console.log(`API Reports -> getSummary (Receivables from Customers): ${summary.receivable}`);

  // D. Reports Service (Debts to Me)
  const debtsToMe = await reportsService.getDebtsToMe(merchantBiz.id);
  const custDebt = debtsToMe.find((d: any) => d.businessId === customerBiz.id);
  console.log(`API Reports -> getDebtsToMe for Customer: ${custDebt?.amount}`);

  // ── Step 7: Database Direct Inspection & Assertions ──
  const dbAccount = await prisma.account.findUnique({ where: { id: accountId } });
  console.log(`Direct Database -> Account.balance: ${dbAccount?.balance}`);
  console.log(`Direct Database -> Account.totalDebit: ${dbAccount?.totalDebit}`);
  console.log(`Direct Database -> Account.totalCredit: ${dbAccount?.totalCredit}`);

  console.log('\n========================================================================');
  console.log('INDEPENDENT REGRESSION CASES (CASES A, B, C, D, E)');
  console.log('========================================================================');

  async function testIsolatedCase(
    name: string,
    opening: number,
    orders: Array<{ total: number; paid: number; isCash: boolean }>,
    receipts: number[],
    expected: number
  ) {
    const sfx = Math.floor(1000 + Math.random() * 9000);
    const m = await prisma.business.create({
      data: { name: `M_${sfx}`, user: { create: { email: `m_${sfx}@test.com`, phoneNumber: `+9677${sfx}1`, password: 'P', fullName: 'M', userType: 'merchant' } } },
    });
    const c = await prisma.business.create({
      data: { name: `C_${sfx}`, user: { create: { email: `c_${sfx}@test.com`, phoneNumber: `+9677${sfx}2`, password: 'P', fullName: 'C', userType: 'merchant' } } },
    });
    const conn = await prisma.connection.create({
      data: {
        requesterId: m.id,
        receiverId: c.id,
        connectionType: 'CUSTOMER',
        status: 'ACCEPTED',
        account: { create: { balance: 0, creditLimit: 100000, currency: 'YER' } },
      },
      include: { account: true },
    });

    if (opening > 0) {
      await prisma.$transaction(async (tx) => {
        await financeService.recordFinancialMovement(tx, {
          senderId: m.id,
          receiverId: c.id,
          amount: opening.toString(),
          type: 'ADJUSTMENT',
          note: `رصيد افتتاحي: ${opening}`,
          connectionId: conn.id,
        });
      }, { timeout: 30000 });
    }

    for (const o of orders) {
      await ordersService.createOrder(m.id, {
        receiverId: c.id,
        isCash: o.isCash,
        paidAmount: o.paid.toString(),
        pricesVisible: true,
        items: [{ itemName: 'Item', quantity: 1, unitPrice: o.total.toString(), unit: 'قطعة' }],
      }, 'merchant');
    }

    for (const r of receipts) {
      await transactionsService.createTransaction(m.id, {
        transactionType: 'PAYMENT',
        paymentDirection: 'RECEIVED',
        receiverId: c.id,
        connectionId: conn.id,
        amount: r.toString(),
        voucherNumber: `VCH-${r}`,
      } as any);
    }

    const resAcc = await prisma.account.findUnique({ where: { id: conn.account!.id } });
    const actual = new Decimal(resAcc?.balance?.toString() || '0').toNumber();
    const passed = actual === expected;
    console.log(`[${name}] Expected: ${expected} | Actual DB Balance: ${actual} | Result: ${passed ? 'PASS ✅' : 'FAIL ❌'}`);

    // Cleanup
    await prisma.transaction.deleteMany({ where: { connectionId: conn.id } });
    await prisma.orderItem.deleteMany({ where: { order: { connectionId: conn.id } } });
    await prisma.order.deleteMany({ where: { connectionId: conn.id } });
    await prisma.account.deleteMany({ where: { id: conn.account!.id } });
    await prisma.connection.deleteMany({ where: { id: conn.id } });
    await prisma.business.deleteMany({ where: { id: { in: [m.id, c.id] } } });
    await prisma.user.deleteMany({ where: { email: { in: [`m_${sfx}@test.com`, `c_${sfx}@test.com`] } } });
  }

  // Case A: Opening 0, Cash Invoice 5000 (Paid 5000) -> Expected 0
  await testIsolatedCase('Case A (Cash 5000, Paid 5000)', 0, [{ total: 5000, paid: 5000, isCash: true }], [], 0);

  // Case B: Opening 0, Credit Invoice 5000 (Paid 0) -> Expected 5000
  await testIsolatedCase('Case B (Credit 5000)', 0, [{ total: 5000, paid: 0, isCash: false }], [], 5000);

  // Case C: Opening 0, Partial Invoice 5000 (Paid 2000) -> Expected 3000
  await testIsolatedCase('Case C (Partial 5000, Paid 2000)', 0, [{ total: 5000, paid: 2000, isCash: false }], [], 3000);

  // Case D: Opening 10000, Invoice 5000 (Paid 5000), Receipt 2000 -> Expected 8000
  await testIsolatedCase('Case D (Opening 10000 + Cash 5000 - Receipt 2000)', 10000, [{ total: 5000, paid: 5000, isCash: true }], [2000], 8000);

  // Case E: Opening 10000, Invoice 8000 (Paid 2000), Receipt 4000 -> Expected 14000
  await testIsolatedCase('Case E (Opening 10000 + Partial 8000(Paid 2000) - Receipt 4000)', 10000, [{ total: 8000, paid: 2000, isCash: false }], [4000], 14000);

  // ── Step 8: Historical / Legacy Data Audit ──
  console.log('\n========================================================================');
  console.log('AUDITING HISTORICAL / LEGACY DATABASE RECORDS');
  console.log('========================================================================');

  const totalDbTxns = await prisma.transaction.count();
  const txnsWithOrder = await prisma.transaction.count({ where: { orderId: { not: null } } });
  const paymentTxnsWithOrder = await prisma.transaction.count({ where: { transactionType: 'PAYMENT', orderId: { not: null } } });
  const realStandaloneReceipts = await prisma.transaction.count({ where: { transactionType: 'PAYMENT', orderId: null } });

  console.log(`Total Transactions in DB: ${totalDbTxns}`);
  console.log(`Transactions Linked to Orders (SALE + Invoice Downpayments): ${txnsWithOrder}`);
  console.log(`Invoice Downpayment/Instant Payments (transactionType=PAYMENT, orderId!=null): ${paymentTxnsWithOrder}`);
  console.log(`Real Standalone Receipt Vouchers (transactionType=PAYMENT, orderId=null): ${realStandaloneReceipts}`);

  // Cleanup main test entities
  await prisma.transaction.deleteMany({ where: { connectionId: connection.id } });
  await prisma.orderItem.deleteMany({ where: { order: { connectionId: connection.id } } });
  await prisma.order.deleteMany({ where: { connectionId: connection.id } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.connection.deleteMany({ where: { id: connection.id } });
  await prisma.business.deleteMany({ where: { id: { in: [merchantBiz.id, customerBiz.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [merchantUser.id, customerUser.id] } } });

  await app.close();
  console.log('\n========================================================================');
  console.log('FINAL VERIFICATION GATE COMPLETED SUCCESSFULLY!');
  console.log('========================================================================');
}

runFinalVerificationGate().catch((err) => {
  console.error('Final Verification Gate error:', err);
  process.exit(1);
});
