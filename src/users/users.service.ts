import { Injectable, NotFoundException, BadRequestException, Logger, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        business: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const { password: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    this.logger.log(`Updating profile for user: ${userId}`);
    return this.prisma.user.update({
      where: { id: userId },
      data: dto,
      select: {
        id: true,
        email: true,
        fullName: true,
        phoneNumber: true,
        userType: true,
        avatarUrl: true,
        isActive: true,
        isEmailVerified: true,
        business: true,
      },
    });
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    this.logger.log(`Changing password for user: ${userId}`);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    const isMatch = await bcrypt.compare(dto.oldPassword, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('كلمة المرور القديمة غير صحيحة');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    this.logger.log(`Updating password for user ID: ${userId}`);
    
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    this.logger.log(`Password updated successfully for user ID: ${userId}`);
    return { message: 'تم تغيير كلمة المرور بنجاح' };
  }

  async changeSecurityPin(userId: string, pin: string) {
    this.logger.log(`Changing security PIN for user: ${userId}`);
    if (pin.length !== 4) {
      throw new BadRequestException('يجب أن يتكون رمز الأمان من 4 أرقام');
    }

    const hashedPin = await bcrypt.hash(pin, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { securityPin: hashedPin },
    });

    return { message: 'تم تغيير رمز الأمان بنجاح' };
  }
}
