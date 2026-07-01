const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  const email = 'admin@admin.com';
  const password = 'Admin@1234';
  const hashedPassword = await bcrypt.hash(password, 10);

  // Check if admin already exists
  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) {
    // Update role to SUPER_ADMIN if needed
    await prisma.user.update({
      where: { id: existing.id },
      data: { role: 'SUPER_ADMIN', isActive: true }
    });
    console.log(`✅ Admin user already exists, role updated to SUPER_ADMIN`);
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);
    return;
  }

  const user = await prisma.user.create({
    data: {
      email,
      password: hashedPassword,
      fullName: 'Super Admin',
      phoneNumber: '0000000000',
      role: 'SUPER_ADMIN',
      isActive: true,
      userType: 'business',
      business: {
        create: {
          name: 'Admin Business',
          businessType: 'Individual',
          phoneNumber: '0000000000',
          email,
        }
      }
    }
  });

  console.log(`✅ Admin user created successfully!`);
  console.log(`   Email: ${email}`);
  console.log(`   Password: ${password}`);
  console.log(`   Role: ${user.role}`);
  console.log(`   ID: ${user.id}`);
}

main()
  .catch((e) => { console.error('❌ Error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
