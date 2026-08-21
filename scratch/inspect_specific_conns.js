const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function inspectConn(connId) {
  const conn = await prisma.connection.findUnique({
    where: { id: connId },
    include: { account: true, orders: true }
  });
  const txns = await prisma.transaction.findMany({
    where: {
      OR: [
        { connectionId: connId },
        { senderId: conn.requesterId, receiverId: conn.receiverId },
        { senderId: conn.receiverId, receiverId: conn.requesterId },
      ]
    }
  });
  console.log(`\n=== Inspection for Connection ${connId} ===`);
  console.log(`Account:`, conn.account);
  console.log(`Orders (${conn.orders.length}):`, conn.orders.map(o => ({ id: o.id, isCash: o.isCash, total: o.total, paid: o.paidAmount })));
  console.log(`All Transactions (${txns.length}):`);
  txns.forEach(t => {
    console.log(`  - [${t.transactionType}] id: ${t.id}, amount: ${t.amount}, note: "${t.note}", connectionId: ${t.connectionId}, orderId: ${t.orderId}`);
  });
}

async function main() {
  await inspectConn('830c1343-b394-4afd-a5ac-46b75034e136');
  await inspectConn('f782dabd-8615-46b5-9de7-0e00fc9eb75e');
  await inspectConn('ce32bcd7-4874-46cd-abef-e0ed570d78b4');
}

main().catch(console.error).finally(() => prisma.$disconnect());
