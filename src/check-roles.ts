import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true },
  });

  console.log('--- User Roles ---');
  users.forEach(u => {
    console.log(`${u.email}: ${u.role}`);
  });
  console.log('------------------');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
