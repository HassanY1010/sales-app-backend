import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Normalizes an identifier (email or phone) for consistent database lookups.
   * If it's a phone number, it strips all non-digit characters.
   * If it's an email, it trims and converts to lowercase.
   */
  /**
   * Normalizes an identifier (email or phone) for consistent database lookups.
   * - Emails: Trimmed and lowercased.
   * - Phone Numbers: Stripped of non-digits and leading zeros (to match common DB storage patterns).
   */
  private normalizeIdentifier(identifier: string): string {
    if (!identifier) return '';
    const trimmed = identifier.trim();
    
    if (trimmed.includes('@')) {
      return trimmed.toLowerCase();
    }
    
    // Treat as phone number: keep only digits and remove leading zero if present
    const digits = trimmed.replace(/\D/g, '');
    return digits.startsWith('0') ? digits.substring(1) : digits;
  }

  async register(dto: RegisterDto) {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const normalizedPhone = this.normalizeIdentifier(dto.phoneNumber);

    this.logger.log(`Attempting to register user with email: ${normalizedEmail}`);
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: normalizedEmail },
          { phoneNumber: normalizedPhone },
        ],
      },
    });

    if (existingUser) {
      if (existingUser.email === normalizedEmail) {
        throw new ConflictException('البريد الإلكتروني مستخدم بالفعل');
      }
      throw new ConflictException('رقم الهاتف مستخدم مسبقا');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const hashedPin = dto.securityPin
      ? await bcrypt.hash(dto.securityPin, 10)
      : undefined;

    let user;
    try {
      user = await this.prisma.user.create({
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
        include: {
          business: true,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to create user: ${error.message}`, error.stack);
      throw error;
    }

    this.logger.log(`User registered successfully: ${user.id}`);

    const payload = {
      sub: user.id,
      email: user.email,
      userType: user.userType,
      role: user.role,
      businessId: (user as any).business?.id,
    };

    const accessToken = this.jwtService.sign(payload);

    // Remove sensitive fields from response
    const { password: _, securityPin: __, ...userWithoutPassword } = user;

    return {
      accessToken,
      user: userWithoutPassword,
    };
  }

  async login(dto: LoginDto) {
    const identifier = this.normalizeIdentifier(dto.email);
    this.logger.log(`Login attempt for normalized identifier: ${identifier}`);
    
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { phoneNumber: identifier },
        ],
      },
      include: {
        business: true,
      },
    });

    if (!user) {
      this.logger.warn(`Login failed: User not found with identifier: ${identifier}`);
      throw new UnauthorizedException('USER_NOT_FOUND:المستخدم غير موجود');
    }

    // Verify user type
    const mappedUserType = dto.userType === 'merchant' ? 'business' : 
                          dto.userType === 'consumer' ? 'individual' : dto.userType;

    const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
    
    if (!isAdmin && dto.userType && user.userType !== mappedUserType) {
      this.logger.warn(`Login failed: Type mismatch for user ${user.id}. Expected ${mappedUserType}, found ${user.userType}`);
      throw new UnauthorizedException('TYPE_MISMATCH:هذا الحساب مسجل كنوع آخر (تاجر/مستهلك)');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);

    if (!isPasswordValid) {
      this.logger.warn(`Login failed: Invalid password for user ${user.id}`);
      throw new UnauthorizedException('INVALID_PASSWORD:كلمة المرور غير صحيحة');
    }

    // Update last login time
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload = {
      sub: user.id,
      email: user.email,
      userType: user.userType,
      role: user.role,
      businessId: user.business?.id,
    };

    const accessToken = this.jwtService.sign(payload);

    this.logger.log(`Login successful for user: ${user.id}`);

    const { password: _, securityPin: __, ...userWithoutPassword } = user;

    return {
      accessToken,
      user: userWithoutPassword,
    };
  }

  async verifyResetPin(identifier: string, pin: string) {
    const normalizedIdentifier = this.normalizeIdentifier(identifier);
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: normalizedIdentifier }, { phoneNumber: normalizedIdentifier }],
      },
    });

    if (!user || !user.securityPin) {
      // Generic message to avoid account enumeration
      throw new UnauthorizedException('البيانات المدخلة غير صحيحة، يرجى المحاولة مرة أخرى أو إنشاء حساب جديد');
    }

    const isPinValid = await bcrypt.compare(pin, user.securityPin);
    if (!isPinValid) {
      throw new UnauthorizedException('البيانات المدخلة غير صحيحة، يرجى المحاولة مرة أخرى أو إنشاء حساب جديد');
    }

    return { success: true, message: 'تم التحقق بنجاح' };
  }

  async resetPassword(identifier: string, newPassword: string, pin: string) {
    const normalizedIdentifier = this.normalizeIdentifier(identifier);
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: normalizedIdentifier }, { phoneNumber: normalizedIdentifier }],
      },
    });

    if (!user || !user.securityPin) {
      throw new UnauthorizedException('البيانات المدخلة غير صحيحة، يرجى المحاولة مرة أخرى أو إنشاء حساب جديد');
    }

    const isPinValid = await bcrypt.compare(pin, user.securityPin);
    if (!isPinValid) {
      throw new UnauthorizedException('البيانات المدخلة غير صحيحة، يرجى المحاولة مرة أخرى أو إنشاء حساب جديد');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: { 
        password: hashedPassword,
        lastLoginAt: new Date(),
      },
      include: {
        business: true,
      },
    });

    const payload = {
      sub: updatedUser.id,
      email: updatedUser.email,
      userType: updatedUser.userType,
      role: updatedUser.role,
      businessId: updatedUser.business?.id,
    };

    const accessToken = this.jwtService.sign(payload);
    const { password: _, securityPin: __, ...userWithoutPassword } = updatedUser;

    return {
      success: true,
      message: 'تم تغيير كلمة المرور بنجاح',
      accessToken,
      user: userWithoutPassword,
    };
  }

  async forgotPassword(identifier: string) {
    const normalizedIdentifier = this.normalizeIdentifier(identifier);
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: normalizedIdentifier }, { phoneNumber: normalizedIdentifier }],
      },
    });

    if (!user) {
      throw new UnauthorizedException('المستخدم غير موجود');
    }

    // In a real app, we would generate a new code and send it via SMS/Email.
    // For this app, we use the securityPin set during registration.
    // If the user doesn't have one, we could generate one here.
    
    return {
      success: true,
      message: 'يرجى استخدام رمز الأمان (PIN) الخاص بك المكون من 4 أرقام لإعادة تعيين كلمة المرور.',
    };
  }
}
