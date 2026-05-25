import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const email = process.env.ADMIN_CHECK_EMAIL;
  if (!email) {
    throw new Error('ADMIN_CHECK_EMAIL is required');
  }
  try {
    const user = await prisma.user.findUnique({
      where: { email },
    });
    console.log('User found:', user ? { id: user.id, email: user.email, role: user.role } : 'NOT FOUND');
  } catch (error) {
    console.error('Error connecting to DB:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
