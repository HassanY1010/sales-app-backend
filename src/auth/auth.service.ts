import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  private normalizeIdentifier(identifier: string): string {
    if (!identifier) return '';
    const trimmed = identifier.trim();
    if (trimmed.includes('@')) return trimmed.toLowerCase();
    const digits = trimmed.replace(/\D/g, '');
    return digits.startsWith('0') ? digits.substring(1) : digits;
  }

  async register(dto: RegisterDto, ipAddress?: string, userAgent?: string | string[]) {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const normalizedPhone = this.normalizeIdentifier(dto.phoneNumber);

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: normalizedEmail }, { phoneNumber: normalizedPhone }],
      },
    });

    if (existingUser) {
      if (existingUser.email === normalizedEmail) {
        throw new ConflictException('البريد الإلكتروني مستخدم بالفعل');
      }
      throw new ConflictException('رقم الهاتف مستخدم مسبقا');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);
    const hashedPin = dto.securityPin ? await bcrypt.hash(dto.securityPin, 12) : undefined;

    const user = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        password: hashedPassword,
        fullName: dto.fullName,
        phoneNumber: normalizedPhone,
        securityPin: hashedPin,
        userType: dto.userType,
        business: {
          create: {
            name: dto.userType === 'business' ? dto.businessName! : dto.fullName,
            businessType: dto.userType === 'business' ? dto.businessType : 'Individual',
            phoneNumber: normalizedPhone,
            email: normalizedEmail,
          },
        },
      },
      include: { business: true },
    });

    const tokens = await this.issueTokens(
      user,
      ipAddress,
      Array.isArray(userAgent) ? userAgent.join(',') : userAgent,
    );
    const { password: _, securityPin: __, ...safeUser } = user;
    return { ...tokens, user: safeUser };
  }

  async login(dto: LoginDto, ipAddress?: string, userAgent?: string | string[]) {
    const identifier = this.normalizeIdentifier(dto.email);
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { phoneNumber: identifier }] },
      include: { business: true },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    }

    const mappedUserType =
      dto.userType === 'merchant'
        ? 'business'
        : dto.userType === 'consumer'
          ? 'individual'
          : dto.userType;
    const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN' || user.role === 'SUPPORT';

    if (!isAdmin && dto.userType && user.userType !== mappedUserType) {
      throw new UnauthorizedException('هذا الحساب مسجل كنوع آخر');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await this.issueTokens(
      user,
      ipAddress,
      Array.isArray(userAgent) ? userAgent.join(',') : userAgent,
    );
    const { password: _, securityPin: __, ...safeUser } = user;
    return { ...tokens, user: safeUser };
  }

  async refresh(refreshToken: string, ipAddress?: string, userAgent?: string | string[]) {
    if (!refreshToken) throw new UnauthorizedException('Refresh token is required');

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
      include: { user: { include: { business: true } } },
    });

    if (!stored || stored.revokedAt || stored.expiresAt <= new Date() || !stored.user.isActive) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const tokens = await this.issueTokens(
      stored.user,
      ipAddress,
      Array.isArray(userAgent) ? userAgent.join(',') : userAgent,
    );
    const { password: _, securityPin: __, ...safeUser } = stored.user;
    return { ...tokens, user: safeUser };
  }

  async logout(refreshToken?: string) {
    if (refreshToken) {
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: this.hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { success: true };
  }

  async verifyResetPin(identifier: string, pin: string) {
    const user = await this.findUserByIdentifier(identifier);
    if (!user?.securityPin) {
      throw new UnauthorizedException('البيانات المدخلة غير صحيحة');
    }
    const isPinValid = await bcrypt.compare(pin, user.securityPin);
    if (!isPinValid) {
      throw new UnauthorizedException('البيانات المدخلة غير صحيحة');
    }
    return { success: true, message: 'تم التحقق بنجاح' };
  }

  async resetPassword(identifier: string, newPassword: string, pin: string) {
    const user = await this.findUserByIdentifier(identifier);
    if (!user?.securityPin) {
      throw new UnauthorizedException('البيانات المدخلة غير صحيحة');
    }
    const isPinValid = await bcrypt.compare(pin, user.securityPin);
    if (!isPinValid) {
      throw new UnauthorizedException('البيانات المدخلة غير صحيحة');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: await bcrypt.hash(newPassword, 12),
        lastLoginAt: new Date(),
      },
      include: { business: true },
    });
    await this.prisma.refreshToken.updateMany({
      where: { userId: updatedUser.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const tokens = await this.issueTokens(updatedUser);
    const { password: _, securityPin: __, ...safeUser } = updatedUser;
    return {
      success: true,
      message: 'تم تغيير كلمة المرور بنجاح',
      ...tokens,
      user: safeUser,
    };
  }

  async forgotPassword(identifier: string) {
    const user = await this.findUserByIdentifier(identifier);
    if (!user) {
      throw new UnauthorizedException('البيانات المدخلة غير صحيحة');
    }
    return {
      success: true,
      message: 'يرجى استخدام رمز الأمان الخاص بك لإعادة تعيين كلمة المرور.',
    };
  }

  private async findUserByIdentifier(identifier: string) {
    const normalizedIdentifier = this.normalizeIdentifier(identifier);
    return this.prisma.user.findFirst({
      where: {
        OR: [{ email: normalizedIdentifier }, { phoneNumber: normalizedIdentifier }],
      },
    });
  }

  private async issueTokens(user: any, ipAddress?: string, userAgent?: string) {
    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      userType: user.userType,
      role: user.role,
      businessId: user.business?.id,
      tokenType: 'access',
    });
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshDays = Number(this.config.get<string>('JWT_REFRESH_EXPIRES_DAYS') || '30');
    const expiresAt = new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        expiresAt,
        ipAddress,
        userAgent,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.get<string>('JWT_EXPIRES_IN') || '15m',
      refreshExpiresAt: expiresAt.toISOString(),
    };
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}
