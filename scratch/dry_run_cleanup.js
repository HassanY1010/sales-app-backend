const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const connections = await prisma.connection.findMany({
    include: {
      account: true,
      transactions: true,
    },
  });

  console.log(`=== DETAILED DRY RUN INSPECTION FOR ALL ${connections.length} CONNECTIONS ===`);

  for (const conn of connections) {
    const acc = conn.account;
    // Find all opening transactions linked directly or unlinked but between these two parties
    const allOpeningTxns = await prisma.transaction.findMany({
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
            ],
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    console.log(`\n------------------------------------------------------------`);
    console.log(`Connection ID: ${conn.id} (${conn.connectionType}, status: ${conn.status})`);
    console.log(`Account ID: ${acc?.id}, Current account.openingBalance: ${acc?.openingBalance}, account.balance: ${acc?.balance}`);
    console.log(`Total Opening Txns Found: ${allOpeningTxns.length}`);
    
    allOpeningTxns.forEach((t, i) => {
      console.log(`  [${i+1}] ID: ${t.id} | amount: ${t.amount} | note: "${t.note}" | connectionId: ${t.connectionId} | createdAt: ${t.createdAt.toISOString()}`);
    });

    if (allOpeningTxns.length > 1) {
      console.log(`  ⚠️ DUPLICATE DETECTED!`);
      // Find candidate
      const matchingAccount = allOpeningTxns.find(t => Number(t.amount) === Number(acc?.openingBalance));
      const canonical = matchingAccount || allOpeningTxns[allOpeningTxns.length - 1];
      const duplicates = allOpeningTxns.filter(t => t.id !== canonical.id);
      console.log(`  -> CANONICAL CANDIDATE: ${canonical.id} (Amount: ${canonical.amount})`);
      console.log(`  -> DUPLICATES TO REMOVE: ${duplicates.map(d => d.id).join(', ')}`);
    } else if (allOpeningTxns.length === 1) {
      console.log(`  -> VALID SINGLE CANONICAL: ${allOpeningTxns[0].id}`);
    } else {
      console.log(`  -> NO OPENING BALANCE (0 or none)`);
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
