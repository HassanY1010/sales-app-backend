import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Checking for users without business records...');
  
  const usersWithoutBusiness = await prisma.user.findMany({
    where: {
      business: {
        is: null,
      },
    },
  });

  console.log(`Found ${usersWithoutBusiness.length} users without business records.`);

  for (const user of usersWithoutBusiness) {
    console.log(`Creating business record for user: ${user.email} (${user.fullName})`);
    await prisma.business.create({
      data: {
        userId: user.id,
        name: user.fullName,
        businessType: 'Individual',
        phoneNumber: user.phoneNumber,
        email: user.email,
      },
    });
  }

  console.log('Fix complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
