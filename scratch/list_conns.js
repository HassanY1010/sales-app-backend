const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const allConn = await prisma.connection.findMany({
    include: { account: true }
  });
  for (const c of allConn) {
    console.log(`Connection ID: ${c.id}, req: ${c.requesterId}, rec: ${c.receiverId}, type: ${c.connectionType}, status: ${c.status}, account: ${c.account ? c.account.id : 'NONE'}`);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
