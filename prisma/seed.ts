import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash('admin123', 10);
  
  const admin = await prisma.user.upsert({
    where: { email: 'admin123@admin123.com' },
    update: {
      password: hashedPassword,
      role: UserRole.SUPER_ADMIN,
    },
    create: {
      email: 'admin123@admin123.com',
      password: hashedPassword,
      fullName: 'System Administrator',
      phoneNumber: '1111111111',
      role: UserRole.SUPER_ADMIN,
      isActive: true,
      isEmailVerified: true,
    },
  });

  console.log('Admin user created/updated:', admin.email);

  // Seed default regions
  const regions = ['صنعاء', 'تعز', 'عدن', 'حضرموت', 'الحديدة'];
  for (const name of regions) {
    await prisma.region.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log('Default regions seeded successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
