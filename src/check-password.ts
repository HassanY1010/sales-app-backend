import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

async function main() {
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { email: 'admin123@admin123.com' },
    });
    if (!user) {
      console.log('User NOT FOUND');
      return;
    }
    const isPasswordValid = await bcrypt.compare('admin123', user.password);
    console.log('Password valid for "admin123":', isPasswordValid);
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
