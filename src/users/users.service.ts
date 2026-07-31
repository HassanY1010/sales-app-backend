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
    const { businessName, ...userFields } = dto;

    if (businessName) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { business: { select: { id: true } } },
      });

      if (user?.business?.id) {
        await this.prisma.business.update({
          where: { id: user.business.id },
          data: { name: businessName.trim() },
        });
      }
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: userFields,
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

    let isMatch = await bcrypt.compare(dto.oldPassword, user.password);
    if (!isMatch && user.tempPasswordHash && user.tempPasswordExpiry && user.tempPasswordExpiry > new Date()) {
      isMatch = await bcrypt.compare(dto.oldPassword, user.tempPasswordHash);
    }
    if (!isMatch) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        tempPasswordHash: null,
        tempPasswordExpiry: null,
        forcePasswordChange: false,
      },
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
      this.logger.error(`❌ updateBusinessLogo: Business profile not found for userId ${userId}`);
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

    this.logger.log(`💾 Prisma DB: Successfully updated Business ${business.id} logoUrl & User ${userId} avatarUrl to: ${logoUrl}`);
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

    this.logger.log(`💾 Prisma DB: Successfully updated User ${user.id} avatarUrl to: ${avatarUrl}`);
    return { url: user.avatarUrl };
  }
}
