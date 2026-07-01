import {
  ConflictException,
  BadRequestException,
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

  private readonly pinAttempts = new Map<
    string,
    { count: number; lockedUntil?: Date }
  >();
  private readonly MAX_PIN_ATTEMPTS = 5;
  private readonly LOCKOUT_MINUTES = 15;

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

  private checkPinLockout(identifier: string): void {
    const record = this.pinAttempts.get(identifier);
    if (!record) return;
    if (record.lockedUntil && record.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (record.lockedUntil.getTime() - Date.now()) / 60000,
      );
      throw new UnauthorizedException(
        `تم تجاوز الحد الأقصى للمحاولات. حاول مجدداً بعد ${minutesLeft} دقيقة.`,
      );
    }
    if (record.lockedUntil && record.lockedUntil <= new Date()) {
      this.pinAttempts.delete(identifier);
    }
  }

  private recordPinFailure(identifier: string): void {
    const record = this.pinAttempts.get(identifier) ?? { count: 0 };
    record.count += 1;
    if (record.count >= this.MAX_PIN_ATTEMPTS) {
      record.lockedUntil = new Date(
        Date.now() + this.LOCKOUT_MINUTES * 60 * 1000,
      );
      this.logger.warn(
        `PIN lockout triggered for identifier: ${identifier.substring(0, 4)}***`,
      );
    }
    this.pinAttempts.set(identifier, record);
  }

  private clearPinFailures(identifier: string): void {
    this.pinAttempts.delete(identifier);
  }

  async register(
    dto: RegisterDto,
    ipAddress?: string,
    userAgent?: string | string[],
  ) {
    if (dto.confirmPassword && dto.confirmPassword !== dto.password) {
      throw new BadRequestException('Password confirmation does not match');
    }

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

    const [hashedPassword, hashedPin] = await Promise.all([
      bcrypt.hash(dto.password, 10),
      dto.securityPin
        ? bcrypt.hash(dto.securityPin, 10)
        : Promise.resolve(undefined),
    ]);

    let referredByAgentId: string | undefined = undefined;
    if (dto.referredByCode) {
      const agent = await this.prisma.agent.findFirst({
        where: {
          referralCode: dto.referredByCode.toUpperCase().trim(),
          status: 'ACTIVE',
        },
      });
      if (!agent) {
        throw new BadRequestException('كود الإحالة المدخل غير صالح أو غير نشط.');
      }
      referredByAgentId = agent.id;
    }

    const user = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        password: hashedPassword,
        fullName: dto.fullName,
        phoneNumber: normalizedPhone,
        securityPin: hashedPin,
        userType: dto.userType,
        referredByAgentId,
        referredAt: referredByAgentId ? new Date() : undefined,
        business: {
          create: {
            name:
              dto.userType === 'business' ? dto.businessName! : dto.fullName,
            businessType:
              dto.userType === 'business' ? dto.businessType : 'مستخدم شخصي',
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

  async login(
    dto: LoginDto,
    ipAddress?: string,
    userAgent?: string | string[],
  ) {
    const identifier = this.normalizeIdentifier(dto.email);
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { phoneNumber: identifier }] },
      include: { business: true },
    });

    if (!user) {
      throw new UnauthorizedException('رقم الهاتف أو كلمة المرور غير صحيحة.');
    }

    if (!user.isActive) {
      throw new UnauthorizedException(
        'تم تعطيل هذا الحساب من قبل الإدارة. يرجى التواصل مع الدعم.',
      );
    }

    const mappedUserType =
      dto.userType === 'merchant'
        ? 'business'
        : dto.userType === 'consumer'
          ? 'individual'
          : dto.userType;
    const isAdmin =
      user.role === 'ADMIN' ||
      user.role === 'SUPER_ADMIN' ||
      user.role === 'SUPPORT';

    if (!isAdmin && dto.userType && user.userType !== mappedUserType) {
      throw new UnauthorizedException('هذا الحساب مسجل كنوع آخر');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('رقم الهاتف أو كلمة المرور غير صحيحة.');
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

  async refresh(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string | string[],
  ) {
    if (!refreshToken)
      throw new UnauthorizedException('Refresh token is required');

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
      include: { user: { include: { business: true } } },
    });

    if (
      !stored ||
      stored.revokedAt ||
      stored.expiresAt <= new Date() ||
      !stored.user.isActive
    ) {
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
    this.checkPinLockout(identifier);
    const user = await this.findUserByIdentifier(identifier);
    if (!user) {
      throw new UnauthorizedException('user_not_found');
    }
    if (!user.securityPin) {
      throw new UnauthorizedException('security_pin_invalid');
    }
    const isPinValid = await bcrypt.compare(pin, user.securityPin);
    if (!isPinValid) {
      this.recordPinFailure(identifier);
      throw new UnauthorizedException('security_pin_invalid');
    }
    this.clearPinFailures(identifier);
    return { success: true, message: 'تم التحقق بنجاح' };
  }

  async resetPassword(identifier: string, newPassword: string, pin: string) {
    this.checkPinLockout(identifier);
    const user = await this.findUserByIdentifier(identifier);
    if (!user) {
      throw new UnauthorizedException('user_not_found');
    }
    if (!user.securityPin) {
      throw new UnauthorizedException('security_pin_invalid');
    }
    const isPinValid = await bcrypt.compare(pin, user.securityPin);
    if (!isPinValid) {
      this.recordPinFailure(identifier);
      throw new UnauthorizedException('security_pin_invalid');
    }
    this.clearPinFailures(identifier);

    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: await bcrypt.hash(newPassword, 10),
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
      throw new UnauthorizedException('غير مسجل');
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
        OR: [
          { email: normalizedIdentifier },
          { phoneNumber: normalizedIdentifier },
        ],
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
    const refreshDays = Number(
      this.config.get<string>('JWT_REFRESH_EXPIRES_DAYS') || '30',
    );
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
