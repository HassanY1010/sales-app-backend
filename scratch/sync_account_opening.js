const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixTwo() {
  await prisma.account.update({
    where: { id: '7134a214-86d2-4e3b-983f-7fcdd87ad6ec' },
    data: { openingBalance: 10000 }
  });
  await prisma.account.update({
    where: { id: '0caa8174-54c4-4858-a0fa-28cbc48e590d' },
    data: { openingBalance: 10000 }
  });
  console.log('Fixed openingBalance on 2 legacy accounts to match canonical transaction value.');
}

fixTwo().catch(console.error).finally(() => prisma.$disconnect());
