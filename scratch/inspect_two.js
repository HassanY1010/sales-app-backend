const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function inspectTwo() {
  for (const id of ['2fe50a95-4c32-4563-8379-4a57b6ec22c6', '43e2711c-2a97-4053-8491-8d1f87136d63']) {
    const conn = await prisma.connection.findUnique({
      where: { id },
      include: { account: true, transactions: true }
    });
    console.log(`\nConn: ${id}`);
    console.log(`account:`, conn.account);
    console.log(`Transactions (${conn.transactions.length}):`);
    conn.transactions.forEach(t => {
      console.log(`  - [${t.transactionType}] id: ${t.id}, amount: ${t.amount}, note: "${t.note}"`);
    });
  }
}

inspectTwo().catch(console.error).finally(() => prisma.$disconnect());
