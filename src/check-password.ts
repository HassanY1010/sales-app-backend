import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

async function main() {
  const prisma = new PrismaClient();
  const email = process.env.ADMIN_CHECK_EMAIL;
  const password = process.env.ADMIN_CHECK_PASSWORD;
  if (!email || !password) {
    throw new Error('ADMIN_CHECK_EMAIL and ADMIN_CHECK_PASSWORD are required');
  }
  try {
    const user = await prisma.user.findUnique({
      where: { email },
    });
    if (!user) {
      console.log('User NOT FOUND');
      return;
    }
    const isPasswordValid = await bcrypt.compare(password, user.password);
    console.log('Password valid:', isPasswordValid);
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
