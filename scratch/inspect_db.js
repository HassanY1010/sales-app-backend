const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const connectionsCount = await prisma.connection.count();
  const accountsCount = await prisma.account.count();
  const transactionsCount = await prisma.transaction.count();
  
  console.log(`Connections: ${connectionsCount}, Accounts: ${accountsCount}, Transactions: ${transactionsCount}`);

  // Find all opening balance adjustments
  const openingTxns = await prisma.transaction.findMany({
    where: {
      transactionType: 'ADJUSTMENT',
      note: { contains: 'افتتاحي' },
    },
  });

  console.log(`Total opening balance transactions in DB: ${openingTxns.length}`);
  openingTxns.forEach(t => {
    console.log(`ID: ${t.id}, connectionId: ${t.connectionId}, senderId: ${t.senderId}, receiverId: ${t.receiverId}, amount: ${t.amount}, note: "${t.note}", createdAt: ${t.createdAt}`);
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
