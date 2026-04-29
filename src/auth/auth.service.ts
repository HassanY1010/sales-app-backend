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

  async register(dto: RegisterDto) {
    this.logger.log(`Attempting to register user with email: ${dto.email}`);
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: dto.email },
          { phoneNumber: dto.phoneNumber },
        ],
      },
    });

    if (existingUser) {
      if (existingUser.email === dto.email) {
        throw new ConflictException('البريد الإلكتروني مستخدم بالفعل');
      }
      throw new ConflictException('رقم الهاتف مسجل بالفعل');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const hashedPin = dto.securityPin
      ? await bcrypt.hash(dto.securityPin, 10)
      : undefined;

    let user;
    try {
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          password: hashedPassword,
          fullName: dto.fullName,
          phoneNumber: dto.phoneNumber,
          securityPin: hashedPin,
          userType: dto.userType,
          business: {
            create: {
              name: dto.userType === 'business' ? dto.businessName! : dto.fullName,
              businessType: dto.userType === 'business' ? dto.businessType : 'Individual',
              phoneNumber: dto.phoneNumber,
              email: dto.email,
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
    this.logger.log(`Login attempt for: ${dto.email}`);
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: dto.email },
          { phoneNumber: dto.email },
        ],
      },
      include: {
        business: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('رقم الهاتف أو كلمة المرور غير صحيحة');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('رقم الهاتف أو كلمة المرور غير صحيحة');
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
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: identifier as string }, { phoneNumber: identifier as string }],
      },
    });

    if (!user || !user.securityPin) {
      throw new UnauthorizedException('البيانات غير صحيحة أو رمز الأمان غير مفعل');
    }

    const isPinValid = await bcrypt.compare(pin as string, user.securityPin);
    if (!isPinValid) {
      throw new UnauthorizedException('رمز الأمان غير صحيح');
    }

    return { success: true, message: 'تم التحقق بنجاح' };
  }

  async resetPassword(identifier: string, newPassword: string, pin: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: identifier }, { phoneNumber: identifier }],
      },
    });

    if (!user || !user.securityPin) {
      throw new UnauthorizedException('المستخدم غير موجود');
    }

    const isPinValid = await bcrypt.compare(pin, user.securityPin);
    if (!isPinValid) {
      throw new UnauthorizedException('رمز الأمان غير صحيح');
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
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: identifier }, { phoneNumber: identifier }],
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
