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
          ...(dto.userType === 'business'
            ? {
                business: {
                  create: {
                    name: dto.businessName!,
                    businessType: dto.businessType,
                    phoneNumber: dto.phoneNumber,
                    email: dto.email,
                  },
                },
              }
            : {}),
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
}
