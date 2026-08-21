const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function sanityCheck() {
  const totalConnections = await prisma.connection.count();
  const totalAcceptedConnections = await prisma.connection.count({ where: { status: 'ACCEPTED' } });
  const totalPendingConnections = await prisma.connection.count({ where: { status: 'PENDING' } });
  const totalBlockedConnections = await prisma.connection.count({ where: { status: 'BLOCKED' } });

  const totalCustomerConnections = await prisma.connection.count({ where: { connectionType: 'CUSTOMER' } });
  const totalSupplierConnections = await prisma.connection.count({ where: { connectionType: 'SUPPLIER' } });

  const totalAccounts = await prisma.account.count();

  // Inspect all transactions with 'افتتاحي'
  const allOpeningTxns = await prisma.transaction.findMany({
    where: {
      transactionType: 'ADJUSTMENT',
      note: { contains: 'افتتاحي' }
    }
  });

  const nullConnectionOpeningTxns = allOpeningTxns.filter(t => t.connectionId === null);
  
  // Group by connectionId
  const connMap = {};
  for (const t of allOpeningTxns) {
    if (!connMap[t.connectionId]) connMap[t.connectionId] = [];
    connMap[t.connectionId].push(t);
  }

  let duplicateOpeningEntries = 0;
  for (const [cId, txns] of Object.entries(connMap)) {
    if (txns.length > 1) {
      duplicateOpeningEntries += (txns.length - 1);
    }
  }

  const accountsWithNonZeroOpening = await prisma.account.count({
    where: {
      openingBalance: { not: 0 }
    }
  });

  console.log('================================================================================');
  console.log('                    INDEPENDENT FINAL SANITY CHECK                              ');
  console.log('================================================================================');
  console.log(`Total Connections in Database: ${totalConnections}`);
  console.log(`  - Accepted Connections: ${totalAcceptedConnections}`);
  console.log(`  - Pending Connections: ${totalPendingConnections}`);
  console.log(`  - Blocked Connections: ${totalBlockedConnections}`);
  console.log(`Total Customer Connections: ${totalCustomerConnections}`);
  console.log(`Total Supplier Connections: ${totalSupplierConnections}`);
  console.log(`Total Financial Accounts: ${totalAccounts}`);
  console.log(`Total Accounts with Opening Balance (!= 0): ${accountsWithNonZeroOpening}`);
  console.log(`Total Opening Balance Transactions in DB: ${allOpeningTxns.length}`);
  console.log(`Total Duplicate Opening Entries: ${duplicateOpeningEntries}`);
  console.log(`Total NULL connectionId Opening Entries: ${nullConnectionOpeningTxns.length}`);
  console.log('================================================================================');
}

sanityCheck().catch(console.error).finally(() => prisma.$disconnect());
