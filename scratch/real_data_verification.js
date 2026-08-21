const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const Decimal = require('decimal.js');

async function verifyAllConnections() {
  const connections = await prisma.connection.findMany({
    include: {
      account: true,
      orders: true,
    }
  });

  console.log('================================================================================');
  console.log('       FINAL REAL PRODUCTION DATA AUDIT & VERIFICATION REPORT                   ');
  console.log('================================================================================\n');

  let totalOpeningCount = 0;
  let duplicateCount = 0;
  let nullConnectionCount = 0;
  let missingOpeningCount = 0;
  let mismatchCount = 0;

  for (const conn of connections) {
    const acc = conn.account;
    if (!acc) continue;

    // 1. Check all opening balance transactions for this connection
    const openingTxns = await prisma.transaction.findMany({
      where: {
        transactionType: 'ADJUSTMENT',
        note: { contains: 'افتتاحي' },
        OR: [
          { connectionId: conn.id },
          {
            connectionId: null,
            OR: [
              { senderId: conn.requesterId, receiverId: conn.receiverId },
              { senderId: conn.receiverId, receiverId: conn.requesterId },
            ]
          }
        ]
      },
      orderBy: { createdAt: 'asc' }
    });

    const hasNullConn = openingTxns.some(t => t.connectionId === null);
    if (hasNullConn) nullConnectionCount++;

    const openingBalanceVal = Number(acc.openingBalance || 0);
    if (openingBalanceVal !== 0) {
      totalOpeningCount++;
      if (openingTxns.length === 0) missingOpeningCount++;
      if (openingTxns.length > 1) duplicateCount++;
    } else {
      if (openingTxns.length > 0) duplicateCount += openingTxns.length;
    }

    // 2. Compute statement / running balance from all operational ledger transactions
    const allTxns = await prisma.transaction.findMany({
      where: { connectionId: conn.id },
      include: { order: true },
      orderBy: { createdAt: 'asc' }
    });

    const isCustomer = (conn.connectionType || 'CUSTOMER').toUpperCase() === 'CUSTOMER';
    let runningCalc = new Decimal(0);
    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);

    for (const t of allTxns) {
      let amount = new Decimal(t.amount);
      if (t.order && (t.transactionType === 'SALE' || t.transactionType === 'PURCHASE')) {
        if (t.order.isCash) {
          amount = new Decimal(0);
        } else if (t.order.paidAmount) {
          const paid = new Decimal(t.order.paidAmount || '0');
          amount = Decimal.max(0, amount.minus(paid));
        }
      }

      switch (t.transactionType) {
        case 'SALE':
          runningCalc = isCustomer ? runningCalc.plus(amount) : runningCalc.minus(amount);
          if (isCustomer) totalDebit = totalDebit.plus(amount);
          else totalCredit = totalCredit.plus(amount);
          break;
        case 'PURCHASE':
          runningCalc = isCustomer ? runningCalc.minus(amount) : runningCalc.plus(amount);
          if (isCustomer) totalCredit = totalCredit.plus(amount);
          else totalDebit = totalDebit.plus(amount);
          break;
        case 'PAYMENT':
          runningCalc = runningCalc.minus(amount);
          if (isCustomer) totalCredit = totalCredit.plus(amount);
          else totalDebit = totalDebit.plus(amount);
          break;
        case 'ADJUSTMENT':
          if (t.note && t.note.includes('افتتاحي')) {
            runningCalc = runningCalc.plus(amount);
            if (isCustomer) {
              if (amount.gt(0)) totalDebit = totalDebit.plus(amount);
              else totalCredit = totalCredit.plus(amount.abs());
            } else {
              if (amount.gt(0)) totalCredit = totalCredit.plus(amount);
              else totalDebit = totalDebit.plus(amount.abs());
            }
          }
          break;
      }
    }

    const serverBalance = new Decimal(acc.balance || 0);
    const diff = serverBalance.minus(runningCalc).abs().toNumber();

    if (diff > 0.001) {
      mismatchCount++;
    }

    console.log(`--------------------------------------------------------------------------------`);
    console.log(`Connection: ${conn.id}`);
    console.log(`Type: ${conn.connectionType} | Status: ${conn.status}`);
    console.log(`Account ID: ${acc.id}`);
    console.log(`Opening Balance: ${openingBalanceVal} | Opening Entry Count: ${openingTxns.length}`);
    console.log(`Server Account Balance: ${serverBalance.toString()} YER`);
    console.log(`Calculated Ledger Balance: ${runningCalc.toString()} YER`);
    console.log(`Total Debit: ${acc.totalDebit} (Calc: ${totalDebit}) | Total Credit: ${acc.totalCredit} (Calc: ${totalCredit})`);
    console.log(`Total Ledger Transactions: ${allTxns.length}`);
    console.log(`Balance Diff (Server - Calculated): ${diff === 0 ? '0 YER (PERFECT MATCH)' : diff + ' YER (MISMATCH)'}`);
  }

  console.log('\n================================================================================');
  console.log('                          FINAL AUDIT SUMMARY                                   ');
  console.log('================================================================================');
  console.log(`Total Active Connections Checked: ${connections.length}`);
  console.log(`Connections with Opening Balance: ${totalOpeningCount}`);
  console.log(`Connections with Duplicate (>1) Opening Entries: ${duplicateCount}`);
  console.log(`Connections with Missing Opening Entry (!=0 balance but 0 txns): ${missingOpeningCount}`);
  console.log(`Connections with connectionId = NULL in Opening Txns: ${nullConnectionCount}`);
  console.log(`Connections with Server Balance != Calculated Statement Balance: ${mismatchCount}`);
  console.log('================================================================================');
}

verifyAllConnections()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
