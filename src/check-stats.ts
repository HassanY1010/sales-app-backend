import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.count();
  const businesses = await prisma.business.count();
  const orders = await prisma.order.count();
  const revenue = await prisma.transaction.aggregate({
    _sum: { amount: true },
  });

  console.log('--- Database Stats ---');
  console.log(`Users: ${users}`);
  console.log(`Businesses: ${businesses}`);
  console.log(`Orders: ${orders}`);
  console.log(`Revenue: ${revenue._sum.amount || 0}`);
  console.log('----------------------');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
