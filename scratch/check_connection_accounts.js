const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const connections = await prisma.connection.findMany({
    include: { account: true, requester: true, receiver: true }
  });
  console.log(`Total connections in database: ${connections.length}`);
  connections.forEach(c => {
    console.log(`Connection ID: ${c.id}`);
    console.log(`Requester: ${c.requester?.name || 'Unknown'}`);
    console.log(`Receiver: ${c.receiver?.name || 'Unknown'}`);
    console.log(`Connection Type: ${c.connectionType}`);
    console.log(`Status: ${c.status}`);
    console.log(`Account ID: ${c.accountId}`);
    console.log(`Account Balance: ${c.account?.balance}`);
    console.log('---');
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
