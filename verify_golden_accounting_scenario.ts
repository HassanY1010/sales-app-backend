import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { PrismaService } from './src/database/prisma.service';
import { OrdersService } from './src/orders/orders.service';
import { FinanceService } from './src/finance/finance.service';
import { TransactionsService } from './src/transactions/transactions.service';
import { Decimal } from 'decimal.js';

async function runGoldenScenario() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const ordersService = app.get(OrdersService);
  const financeService = app.get(FinanceService);
  const transactionsService = app.get(TransactionsService);

  console.log('========================================================================');
  console.log('STARTING GOLDEN SCENARIO DATABASE & ACCOUNTING ENGINE VERIFICATION');
  console.log('========================================================================');

  const randSuffix = Math.floor(10000 + Math.random() * 90000);

  // 1. Create Merchant (Supplier) and Customer (Receiver)
  const merchantUser = await prisma.user.create({
    data: {
      email: `merchant_${Date.now()}_${randSuffix}@test.com`,
      phoneNumber: `+96777${randSuffix}1`,
      password: 'Password123!',
      fullName: 'التاجر الرئيسي',
      userType: 'merchant',
    },
  });
  const merchantBiz = await prisma.business.create({
    data: {
      name: `مؤسسة التاجر ${randSuffix}`,
      userId: merchantUser.id,
    },
  });

  const customerUser = await prisma.user.create({
    data: {
      email: `customer_${Date.now()}_${randSuffix}@test.com`,
      phoneNumber: `+96777${randSuffix}2`,
      password: 'Password123!',
      fullName: 'العميل محمد',
      userType: 'merchant',
    },
  });
  const customerBiz = await prisma.business.create({
    data: {
      name: `مؤسسة العميل محمد ${randSuffix}`,
      userId: customerUser.id,
    },
  });

  // Create Connection between Merchant & Customer (Role = CUSTOMER)
  const connection = await prisma.connection.create({
    data: {
      requesterId: merchantBiz.id,
      receiverId: customerBiz.id,
      connectionType: 'CUSTOMER',
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

  // ── Step 0: Opening Balance = 10,000 ──
  console.log('\n--- Step 0: Opening Balance 10,000 YER ---');
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

  let acc = await prisma.account.findUnique({ where: { id: accountId } });
  console.log(`Account.balance after Opening Balance: ${acc?.balance}`);

  // ── Step 1: Credit Invoice = 5,000 (Paid = 0) ──
  console.log('\n--- Step 1: Credit Invoice 5,000 YER (Paid 0) ---');
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
  acc = await prisma.account.findUnique({ where: { id: accountId } });
  console.log(`Order Number: ${creditOrder.orderNumber}`);
  console.log(`Account.balance after Credit Invoice: ${acc?.balance}`);

  // ── Step 2: Cash Invoice = 3,000 (Paid = 3,000) ──
  console.log('\n--- Step 2: Cash Invoice 3,000 YER (Paid 3,000) ---');
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
  acc = await prisma.account.findUnique({ where: { id: accountId } });
  console.log(`Order Number: ${cashOrder.orderNumber}`);
  console.log(`Account.balance after Cash Invoice: ${acc?.balance}`);

  // ── Step 3: Partial Invoice = 8,000 (Paid = 2,000, Remaining = 6,000) ──
  console.log('\n--- Step 3: Partial Invoice 8,000 YER (Paid 2,000) ---');
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
  acc = await prisma.account.findUnique({ where: { id: accountId } });
  console.log(`Order Number: ${partialOrder.orderNumber}`);
  console.log(`Account.balance after Partial Invoice: ${acc?.balance}`);

  // ── Step 4: Real Standalone Receipt = 4,000 ──
  console.log('\n--- Step 4: Real Receipt 4,000 YER ---');
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
  acc = await prisma.account.findUnique({ where: { id: accountId } });
  console.log(`Receipt 1 Voucher: ${receipt1.voucherNumber}`);
  console.log(`Account.balance after Real Receipt 1: ${acc?.balance}`);

  // ── Step 5: Real Standalone Receipt = 7,000 ──
  console.log('\n--- Step 5: Real Receipt 7,000 YER ---');
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
  acc = await prisma.account.findUnique({ where: { id: accountId } });
  console.log(`Receipt 2 Voucher: ${receipt2.voucherNumber}`);
  console.log(`Account.balance after Real Receipt 2: ${acc?.balance}`);

  // ── Database Verification & Inspection ──
  console.log('\n========================================================================');
  console.log('COMPLETE DATABASE TRANSACTION AUDIT TRAIL');
  console.log('========================================================================');

  const allTxns = await prisma.transaction.findMany({
    where: { connectionId: connection.id },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Total Transactions Created in DB: ${allTxns.length}`);
  allTxns.forEach((t, i) => {
    console.log(
      `[#${i + 1}] ID: ${t.id} | Type: ${t.transactionType} | Amount: ${t.amount} | orderId: ${t.orderId || 'NULL'} | balanceAfter: ${t.balanceAfter} | Note: ${t.note}`
    );
  });

  console.log('\n========================================================================');
  console.log('FINAL PROOF & ASSERTIONS');
  console.log('========================================================================');
  console.log(`Final Database Account.balance: ${acc?.balance}`);
  console.log(`Expected Final Balance: 10000`);

  const isFinalMatch = new Decimal(acc?.balance?.toString() || '0').equals(10000);
  console.log(`Database Balance Equals 10,000: ${isFinalMatch ? 'YES (PASS)' : 'NO (FAIL)'}`);

  // Clean up test data
  await prisma.transaction.deleteMany({ where: { connectionId: connection.id } });
  await prisma.orderItem.deleteMany({ where: { order: { connectionId: connection.id } } });
  await prisma.order.deleteMany({ where: { connectionId: connection.id } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.connection.deleteMany({ where: { id: connection.id } });
  await prisma.business.deleteMany({ where: { id: { in: [merchantBiz.id, customerBiz.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [merchantUser.id, customerUser.id] } } });

  await app.close();
}

runGoldenScenario().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
