import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
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

    const { password: _, securityPin: __, ...userWithoutSecrets } = user;
    return userWithoutSecrets;
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
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const isMatch = await bcrypt.compare(dto.oldPassword, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { message: 'Password changed successfully' };
  }

  async changeSecurityPin(userId: string, pin: string) {
    if (!/^[A-Za-z0-9]{4}$/.test(pin)) {
      throw new BadRequestException(
        'Security PIN must be exactly 4 letters or digits',
      );
    }

    const hashedPin = await bcrypt.hash(pin, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { securityPin: hashedPin },
    });

    return { message: 'Security PIN changed successfully' };
  }

  async updatePushToken(userId: string, pushToken: string) {
    if (!pushToken || pushToken.trim().length < 20) {
      throw new BadRequestException('Invalid push notification token');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { pushToken: pushToken.trim() },
    });

    return { message: 'Push notification token updated successfully' };
  }

  async updateBusinessLogo(userId: string, logoUrl: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { business: { select: { id: true } } },
    });

    if (!user?.business?.id) {
      throw new NotFoundException('Business profile not found');
    }

    const business = await this.prisma.business.update({
      where: { id: user.business.id },
      data: { logoUrl },
      select: {
        id: true,
        logoUrl: true,
      },
    });

    // Also update user's avatarUrl to keep profile image synchronized
    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: logoUrl },
    });

    return { url: business.logoUrl };
  }

  async updateUserAvatar(userId: string, avatarUrl: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
      select: {
        id: true,
        avatarUrl: true,
      },
    });

    return { url: user.avatarUrl };
  }
}
