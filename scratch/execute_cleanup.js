const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('=== RUNNING SAFE PRODUCTION DATA CLEANUP TRANSACTION ===');

  await prisma.$transaction(async (tx) => {
    // 1. Connection 830c1343-b394-4afd-a5ac-46b75034e136:
    // Has 2 duplicate Opening Balance transactions (09b6afc7... and b423bb98...) both with amount 4000
    // Keep 09b6afc7-5022-40d5-abcb-790c387f7912 as Canonical
    // Delete duplicate b423bb98-b500-4b4b-af37-46039dd49475
    const dupTxn = await tx.transaction.findUnique({
      where: { id: 'b423bb98-b500-4b4b-af37-46039dd49475' }
    });
    if (dupTxn) {
      console.log(`Deleting duplicate transaction b423bb98-b500-4b4b-af37-46039dd49475 (Amount: ${dupTxn.amount})`);
      await tx.transaction.delete({ where: { id: 'b423bb98-b500-4b4b-af37-46039dd49475' } });
    }

    // 2. Connection ce32bcd7-4874-46cd-abef-e0ed570d78b4:
    // Has account with openingBalance: 7500, but 0 transactions with its connectionId.
    // Create its canonical opening transaction with connectionId
    const connCe = await tx.connection.findUnique({
      where: { id: 'ce32bcd7-4874-46cd-abef-e0ed570d78b4' },
      include: { account: true }
    });
    if (connCe && connCe.account && Number(connCe.account.openingBalance) === 7500) {
      const existing = await tx.transaction.findFirst({
        where: {
          connectionId: connCe.id,
          transactionType: 'ADJUSTMENT',
          note: { contains: 'افتتاحي' }
        }
      });
      if (!existing) {
        console.log(`Creating canonical opening balance transaction for connection ce32bcd7... with amount 7500`);
        await tx.transaction.create({
          data: {
            transactionType: 'ADJUSTMENT',
            amount: 7500,
            senderId: connCe.requesterId,
            receiverId: connCe.receiverId,
            connectionId: connCe.id,
            note: 'رصيد افتتاحي: 7500'
          }
        });
      }
    }

    // 3. Ensure all existing opening transactions have their proper connectionId linked
    const unlinkedOpening = await tx.transaction.findMany({
      where: {
        transactionType: 'ADJUSTMENT',
        note: { contains: 'افتتاحي' },
        connectionId: null
      }
    });
    console.log(`Unlinked opening transactions with connectionId=null: ${unlinkedOpening.length}`);
    for (const t of unlinkedOpening) {
      // Find matching connection
      const conn = await tx.connection.findFirst({
        where: {
          OR: [
            { requesterId: t.senderId, receiverId: t.receiverId },
            { requesterId: t.receiverId, receiverId: t.senderId }
          ]
        }
      });
      if (conn) {
        console.log(`Relinking unlinked transaction ${t.id} to connection ${conn.id}`);
        await tx.transaction.update({
          where: { id: t.id },
          data: { connectionId: conn.id }
        });
      }
    }
  });

  console.log('=== CLEANUP TRANSACTION COMPLETED SUCCESSFULLY ===');
}

main().catch(console.error).finally(() => prisma.$disconnect());
