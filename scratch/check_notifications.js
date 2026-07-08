const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const count = await prisma.notification.count();
  console.log(`Total notifications in database: ${count}`);
  const sample = await prisma.notification.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' }
  });
  console.log('Last 5 notifications:', JSON.stringify(sample, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
