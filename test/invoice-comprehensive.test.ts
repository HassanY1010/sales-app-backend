import { PrismaClient } from '@prisma/client';
import { InvoiceNumberService } from '../src/common/invoice-number.service';
import { FinanceService } from '../src/finance/finance.service';
import { OrdersService } from '../src/orders/orders.service';

const prisma = new PrismaClient();

async function runComprehensiveTests() {
  console.log('=== STARTING COMPREHENSIVE INVOICE VERIFICATION ===');
  
  const mockEventsGateway: any = { emitToBusiness: () => {} };
  const mockNotificationsService: any = { sendPushNotification: async () => {} };
  const invoiceNumberService = new InvoiceNumberService(prisma as any);
  const financeService = new FinanceService(
    prisma as any,
    mockNotificationsService,
    mockEventsGateway,
  );
  const ordersService = new OrdersService(
    prisma as any,
    financeService,
    mockNotificationsService,
    mockEventsGateway,
    invoiceNumberService,
  );

  // Connection: بقالة صنعاء (requester) -> بقالة الفجر (receiver)
  const connectionId = '16d19b59-edaa-4b14-a726-f427217bf201';
  const senderId = '5cd6e87e-0147-4ea9-82bc-5bc60c11648b'; // بقالة صنعاء
  const receiverId = '33e593d4-079f-49d2-ae14-891a31a34639'; // بقالة الفجر

  const createdOrderIds: string[] = [];

  try {
    await invoiceNumberService.ensureTablesExist();

    // ----------------------------------------------------
    // TEST A: CASH INVOICE (qty=1, unitPrice=1000, paid=1000)
    // ----------------------------------------------------
    console.log('\n--- Running TEST A: CASH INVOICE ---');
    const initialAccount = await prisma.account.findUnique({ where: { connectionId } });
    const initialBalance = Number(initialAccount?.balance || 0);

    const cashOrder = await ordersService.createOrder(
      senderId,
      {
        receiverId,
        connectionId,
        accountRole: 'CUSTOMER',
        isCash: true,
        pricesVisible: true,
        items: [{ itemName: 'منتج تجريبي 1', quantity: 1, unitPrice: '1000', unit: 'قطعة' }],
        paidAmount: '1000',
        discount: '0',
        currency: 'YER',
      },
      'business',
    );
    createdOrderIds.push(cashOrder.id);

    // Verify in DB
    const dbCashOrder = await prisma.order.findUnique({
      where: { id: cashOrder.id },
      include: { items: true, transactions: true },
    });
    const cashAccountAfter = await prisma.account.findUnique({ where: { connectionId } });
    const cashBalanceAfter = Number(cashAccountAfter?.balance || 0);

    const testAPassed =
      dbCashOrder !== null &&
      dbCashOrder.isCash === true &&
      Number(dbCashOrder.total) === 1000 &&
      Number(dbCashOrder.paidAmount) === 1000 &&
      dbCashOrder.items.length === 1 &&
      dbCashOrder.items[0].itemName === 'منتج تجريبي 1' &&
      Number(dbCashOrder.items[0].unitPrice) === 1000 &&
      cashBalanceAfter === initialBalance; // Cash invoice does not increase debt

    console.log('TEST A Result:', {
      orderId: dbCashOrder?.id,
      orderNumber: dbCashOrder?.orderNumber,
      total: dbCashOrder?.total.toString(),
      paidAmount: dbCashOrder?.paidAmount.toString(),
      itemsCount: dbCashOrder?.items.length,
      balanceBefore: initialBalance,
      balanceAfter: cashBalanceAfter,
      status: testAPassed ? 'PASS' : 'FAIL',
    });

    // ----------------------------------------------------
    // TEST B: CREDIT INVOICE (qty=1, unitPrice=1000, paid=0)
    // ----------------------------------------------------
    console.log('\n--- Running TEST B: CREDIT INVOICE ---');
    const creditOrder = await ordersService.createOrder(
      senderId,
      {
        receiverId,
        connectionId,
        accountRole: 'CUSTOMER',
        isCash: false,
        pricesVisible: true,
        items: [{ itemName: 'منتج تجريبي 2', quantity: 1, unitPrice: '1000', unit: 'قطعة' }],
        paidAmount: '0',
        discount: '0',
        currency: 'YER',
      },
      'business',
    );
    createdOrderIds.push(creditOrder.id);

    const dbCreditOrder = await prisma.order.findUnique({
      where: { id: creditOrder.id },
      include: { items: true, transactions: true },
    });
    const creditAccountAfter = await prisma.account.findUnique({ where: { connectionId } });
    const creditBalanceAfter = Number(creditAccountAfter?.balance || 0);

    const testBPassed =
      dbCreditOrder !== null &&
      dbCreditOrder.isCash === false &&
      Number(dbCreditOrder.total) === 1000 &&
      Number(dbCreditOrder.paidAmount) === 0 &&
      dbCreditOrder.items.length === 1 &&
      creditBalanceAfter === cashBalanceAfter + 1000; // Credit increases debt by 1000

    console.log('TEST B Result:', {
      orderId: dbCreditOrder?.id,
      orderNumber: dbCreditOrder?.orderNumber,
      total: dbCreditOrder?.total.toString(),
      paidAmount: dbCreditOrder?.paidAmount.toString(),
      itemsCount: dbCreditOrder?.items.length,
      balanceBefore: cashBalanceAfter,
      balanceAfter: creditBalanceAfter,
      status: testBPassed ? 'PASS' : 'FAIL',
    });

    // ----------------------------------------------------
    // TEST C: PARTIAL INVOICE (qty=1, unitPrice=1000, paid=400, remaining=600)
    // ----------------------------------------------------
    console.log('\n--- Running TEST C: PARTIAL INVOICE ---');
    const partialOrder = await ordersService.createOrder(
      senderId,
      {
        receiverId,
        connectionId,
        accountRole: 'CUSTOMER',
        isCash: false,
        pricesVisible: true,
        items: [{ itemName: 'منتج تجريبي 3', quantity: 1, unitPrice: '1000', unit: 'قطعة' }],
        paidAmount: '400',
        discount: '0',
        currency: 'YER',
      },
      'business',
    );
    createdOrderIds.push(partialOrder.id);

    const dbPartialOrder = await prisma.order.findUnique({
      where: { id: partialOrder.id },
      include: { items: true, transactions: true },
    });
    const partialAccountAfter = await prisma.account.findUnique({ where: { connectionId } });
    const partialBalanceAfter = Number(partialAccountAfter?.balance || 0);

    const testCPassed =
      dbPartialOrder !== null &&
      dbPartialOrder.isCash === false &&
      Number(dbPartialOrder.total) === 1000 &&
      Number(dbPartialOrder.paidAmount) === 400 &&
      dbPartialOrder.items.length === 1 &&
      partialBalanceAfter === creditBalanceAfter + 600; // Partial net impact is 600

    console.log('TEST C Result:', {
      orderId: dbPartialOrder?.id,
      orderNumber: dbPartialOrder?.orderNumber,
      total: dbPartialOrder?.total.toString(),
      paidAmount: dbPartialOrder?.paidAmount.toString(),
      remainingAmount: (1000 - 400).toString(),
      itemsCount: dbPartialOrder?.items.length,
      balanceBefore: creditBalanceAfter,
      balanceAfter: partialBalanceAfter,
      status: testCPassed ? 'PASS' : 'FAIL',
    });

    // ----------------------------------------------------
    // TEST D: CONCURRENCY TEST (Simultaneous invoice creation)
    // ----------------------------------------------------
    console.log('\n--- Running TEST D: CONCURRENCY TEST ---');
    const concurrentPromises = [1, 2, 3, 4, 5].map((idx) =>
      ordersService.createOrder(
        senderId,
        {
          receiverId,
          connectionId,
          accountRole: 'CUSTOMER',
          isCash: true,
          pricesVisible: true,
          items: [{ itemName: `صنف متزامن ${idx}`, quantity: 1, unitPrice: '100', unit: 'قطعة' }],
          paidAmount: '100',
          currency: 'YER',
        },
        'business',
      ),
    );

    const concurrentResults = await Promise.all(concurrentPromises);
    const orderNumbers = concurrentResults.map((r) => r.orderNumber);
    concurrentResults.forEach((r) => createdOrderIds.push(r.id));

    const uniqueNumbers = new Set(orderNumbers);
    const testDPassed = uniqueNumbers.size === orderNumbers.length;

    console.log('TEST D Result:', {
      concurrencyCount: concurrentResults.length,
      generatedOrderNumbers: orderNumbers,
      uniqueCount: uniqueNumbers.size,
      hasDuplicates: uniqueNumbers.size !== orderNumbers.length,
      status: testDPassed ? 'PASS' : 'FAIL',
    });

    // ----------------------------------------------------
    // TEST E: ATOMIC TRANSACTION ROLLBACK TEST
    // ----------------------------------------------------
    console.log('\n--- Running TEST E: TRANSACTION ROLLBACK TEST ---');
    const balanceBeforeRollbackTest = Number(
      (await prisma.account.findUnique({ where: { connectionId } }))?.balance || 0,
    );
    const ordersCountBefore = await prisma.order.count({ where: { senderId } });

    let rollbackCaught = false;
    try {
      await prisma.$transaction(async (tx) => {
        // Step 1: Create an order in transaction
        const orderNum = await invoiceNumberService.getNextInvoiceNumber(senderId, tx);
        const o = await tx.order.create({
          data: {
            orderNumber: orderNum,
            senderId,
            receiverId,
            connectionId,
            status: 'ISSUED',
            total: '1000',
            paidAmount: '0',
          },
        });
        // Step 2: Intentionally trigger an error (e.g. simulate invalid FK or forced throw)
        throw new Error('SIMULATED_FAILURE_FOR_ROLLBACK_VERIFICATION');
      });
    } catch (err: any) {
      if (err.message === 'SIMULATED_FAILURE_FOR_ROLLBACK_VERIFICATION') {
        rollbackCaught = true;
      }
    }

    const ordersCountAfter = await prisma.order.count({ where: { senderId } });
    const balanceAfterRollbackTest = Number(
      (await prisma.account.findUnique({ where: { connectionId } }))?.balance || 0,
    );

    const testEPassed =
      rollbackCaught &&
      ordersCountBefore === ordersCountAfter &&
      balanceBeforeRollbackTest === balanceAfterRollbackTest;

    console.log('TEST E Result:', {
      errorSimulatedAndCaught: rollbackCaught,
      ordersCountBefore,
      ordersCountAfter,
      balanceBefore: balanceBeforeRollbackTest,
      balanceAfter: balanceAfterRollbackTest,
      status: testEPassed ? 'PASS' : 'FAIL',
    });

    // ----------------------------------------------------
    // Clean up created test orders and restore account balance
    // ----------------------------------------------------
    console.log('\n--- Cleaning up test records and restoring balance ---');
    for (const id of createdOrderIds) {
      await prisma.transaction.deleteMany({ where: { orderId: id } });
      await prisma.orderItem.deleteMany({ where: { orderId: id } });
      await prisma.order.delete({ where: { id } });
    }
    await prisma.account.update({
      where: { connectionId },
      data: { balance: initialBalance.toString() },
    });
    console.log('Cleanup complete. Restored balance to:', initialBalance);

  } catch (err) {
    console.error('Test execution error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

runComprehensiveTests();
