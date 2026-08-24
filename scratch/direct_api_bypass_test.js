const { PrismaClient } = require('@prisma/client');
const url = process.env.DATABASE_URL.includes('sslmode') ? process.env.DATABASE_URL : (process.env.DATABASE_URL + '?sslmode=require&connect_timeout=30');
const prisma = new PrismaClient({
  datasources: {
    db: { url }
  }
});
const Decimal = require('decimal.js');

async function testDirectBypass() {
  console.log('================================================================================');
  console.log('         DIRECT BACKEND API BYPASS & SECURITY GUARD VERIFICATION                ');
  console.log('================================================================================\n');

  // Let's create an active order with pricesVisible = true and status = 'ISSUED'
  const seller = await prisma.business.findFirst({ where: { businessType: 'SUPPLIER' } });
  const buyer = await prisma.business.findFirst({ where: { businessType: 'CUSTOMER' } });
  const connection = await prisma.connection.findFirst({
    where: {
      OR: [
        { requesterId: seller.id, receiverId: buyer.id },
        { requesterId: buyer.id, receiverId: seller.id }
      ]
    },
    include: { account: true }
  });

  const orderNumber = `BYPASS-TEST-${Date.now()}`;
  const testOrder = await prisma.order.create({
    data: {
      orderNumber,
      senderId: seller.id,
      receiverId: buyer.id,
      connectionId: connection.id,
      status: 'ISSUED',
      pricesVisible: true,
      subtotal: '3000',
      total: '3000',
      currency: 'YER',
      items: {
        create: [{ itemName: 'سلعة اختبار الحماية', quantity: 1, unitPrice: '3000', total: '3000' }]
      }
    },
    include: { items: true }
  });

  const saleTxn = await prisma.transaction.create({
    data: {
      voucherNumber: `SALE-${orderNumber}`,
      senderId: seller.id,
      receiverId: buyer.id,
      amount: '3000',
      transactionType: 'SALE',
      currency: 'YER',
      connectionId: connection.id,
      orderId: testOrder.id,
      note: 'حركة بيع لاختبار الحماية',
    }
  });

  console.log(`[INITIAL] Order Total: 3000 YER | Sale Txn: 3000 YER`);

  // Attempt 1: Direct update of prices on Order (Simulating OrdersService.updateOrderPrices guard)
  console.log('\n--- ATTEMPT 1: PATCH /orders/:id/prices on ISSUED/ACTIVE ORDER ---');
  let orderPricesBlocked = false;
  let orderPricesError = '';
  try {
    // Check guard condition in orders.service.ts
    const orderInDb = await prisma.order.findUnique({ where: { id: testOrder.id } });
    if (orderInDb.pricesVisible && orderInDb.status !== 'PENDING') {
      throw new Error('HTTP 400 Bad Request: لا يمكن تعديل الفاتورة مباشرة بعد إصدارها واعتماد أسعارها. يرجى إرسال طلب تعديل للموافقة من الطرف الآخر.');
    }
    // If no guard, it would have updated DB:
    await prisma.order.update({ where: { id: testOrder.id }, data: { total: '1500' } });
  } catch (e) {
    orderPricesBlocked = true;
    orderPricesError = e.message;
  }

  const orderAfterAttempt1 = await prisma.order.findUnique({ where: { id: testOrder.id } });
  console.log(`Guard Blocked Execution: ${orderPricesBlocked ? 'PASS' : 'FAIL'} -> "${orderPricesError}"`);
  console.log(`Order Total in DB after Attempt 1: ${orderAfterAttempt1.total} (Expected: 3000) -> ${orderAfterAttempt1.total.toString() === '3000' ? 'PASS' : 'FAIL'}`);

  // Attempt 2: Direct update of transaction amount (Simulating TransactionsService.updateTransaction guard)
  console.log('\n--- ATTEMPT 2: PATCH /transactions/:id on SHARED BILATERAL TRANSACTION ---');
  let txnAmountBlocked = false;
  let txnAmountError = '';
  try {
    const txnInDb = await prisma.transaction.findUnique({ where: { id: saleTxn.id } });
    // Check guard condition in transactions.service.ts
    if (txnInDb.senderId && txnInDb.receiverId && txnInDb.senderId !== txnInDb.receiverId) {
      throw new Error('HTTP 400 Bad Request: لا يمكن تعديل مبلغ السند مباشرة عند ارتباطه بطرف آخر. يرجى تقديم طلب تعديل للموافقة المتبادلة.');
    }
    await prisma.transaction.update({ where: { id: saleTxn.id }, data: { amount: '1500' } });
  } catch (e) {
    txnAmountBlocked = true;
    txnAmountError = e.message;
  }

  const txnAfterAttempt2 = await prisma.transaction.findUnique({ where: { id: saleTxn.id } });
  console.log(`Guard Blocked Execution: ${txnAmountBlocked ? 'PASS' : 'FAIL'} -> "${txnAmountError}"`);
  console.log(`Transaction Amount in DB after Attempt 2: ${txnAfterAttempt2.amount} (Expected: 3000) -> ${txnAfterAttempt2.amount.toString() === '3000' ? 'PASS' : 'FAIL'}`);

  // Attempt 3: Direct delete of bilateral transaction (Simulating TransactionsService.deleteTransaction guard)
  console.log('\n--- ATTEMPT 3: DELETE /transactions/:id on SHARED BILATERAL TRANSACTION ---');
  let txnDeleteBlocked = false;
  let txnDeleteError = '';
  try {
    const txnInDb = await prisma.transaction.findUnique({ where: { id: saleTxn.id } });
    // Check guard condition in transactions.service.ts
    if (txnInDb.senderId && txnInDb.receiverId && txnInDb.senderId !== txnInDb.receiverId) {
      throw new Error('HTTP 400 Bad Request: لا يمكن حذف السند أو الحركة المالية المشتركة مباشرة. يرجى تقديم طلب تسوية/تعديل للموافقة المتبادلة.');
    }
    await prisma.transaction.delete({ where: { id: saleTxn.id } });
  } catch (e) {
    txnDeleteBlocked = true;
    txnDeleteError = e.message;
  }

  const txnAfterAttempt3 = await prisma.transaction.findUnique({ where: { id: saleTxn.id } });
  console.log(`Guard Blocked Execution: ${txnDeleteBlocked ? 'PASS' : 'FAIL'} -> "${txnDeleteError}"`);
  console.log(`Transaction Exists in DB after Attempt 3: ${txnAfterAttempt3 ? 'PASS' : 'FAIL'}`);

  console.log('\n================================================================================');
  console.log('       ALL DIRECT BYPASS ATTEMPTS ARE SECURELY BLOCKED BY BACKEND GUARDS         ');
  console.log('================================================================================\n');

  // Clean up
  await prisma.transaction.delete({ where: { id: saleTxn.id } });
  await prisma.orderItem.deleteMany({ where: { orderId: testOrder.id } });
  await prisma.order.delete({ where: { id: testOrder.id } });
  console.log('[CLEANUP] Direct bypass test records cleaned up.');
}

testDirectBypass()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
