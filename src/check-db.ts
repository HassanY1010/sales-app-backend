import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { email: 'admin123@admin123.com' },
    });
    console.log('User found:', user ? { id: user.id, email: user.email, role: user.role } : 'NOT FOUND');
  } catch (error) {
    console.error('Error connecting to DB:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
