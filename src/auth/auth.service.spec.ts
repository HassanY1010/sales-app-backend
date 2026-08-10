import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const user = {
    id: 'user-1',
    email: 'owner@example.com',
    password: '',
    fullName: 'Owner',
    phoneNumber: '555123456',
    userType: 'business',
    role: 'USER',
    isActive: true,
    securityPin: null,
    business: { id: 'business-1', name: 'Store' },
  };

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'JWT_REFRESH_EXPIRES_DAYS') return '30';
      if (key === 'JWT_EXPIRES_IN') return '15m';
      return undefined;
    }),
  };

  const jwtService = {
    sign: jest.fn(() => 'access-token'),
  };

  function createService(prismaOverrides: Record<string, any> = {}) {
    const prisma = {
      user: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      refreshToken: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      ...prismaOverrides,
    };

    return {
      prisma,
      service: new AuthService(prisma as any, jwtService as any, config as any, {} as any),
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    user.password = await bcrypt.hash('StrongPass123!', 12);
  });

  it('normalizes email and phone login identifiers and returns access plus refresh tokens', async () => {
    const { prisma, service } = createService();
    prisma.user.findFirst.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({ ...user, lastLoginAt: new Date() });
    prisma.refreshToken.create.mockResolvedValue({});

    const result = await service.login({
      email: '  OWNER@EXAMPLE.COM ',
      password: 'StrongPass123!',
      userType: 'merchant',
    });

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { email: 'owner@example.com' },
          { phoneNumber: 'owner@example.com' },
        ],
      },
      include: { business: true },
    });
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBeTruthy();
    expect((result.user as any).password).toBeUndefined();
    expect(prisma.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        tokenHash: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    });
  });

  it('rejects login when the selected user type does not match the stored account type', async () => {
    const { prisma, service } = createService();
    prisma.user.findFirst.mockResolvedValue(user);

    await expect(
      service.login({
        email: 'owner@example.com',
        password: 'StrongPass123!',
        userType: 'consumer',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('prevents duplicate registration by normalized email or phone', async () => {
    const { prisma, service } = createService();
    prisma.user.findFirst.mockResolvedValue(user);

    await expect(
      service.register({
        fullName: 'New Owner',
        email: 'OWNER@EXAMPLE.COM',
        password: 'StrongPass123!',
        phoneNumber: '0555123456',
        securityPin: '1234',
        userType: 'business',
        businessName: 'Store',
        businessType: 'Retail',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rotates refresh tokens and revokes the previous token', async () => {
    const refreshToken = 'refresh-token-value';
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const { prisma, service } = createService();
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'refresh-1',
      tokenHash,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user,
    });
    prisma.refreshToken.update.mockResolvedValue({});
    prisma.refreshToken.create.mockResolvedValue({});

    const result = await service.refresh(refreshToken);

    expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash },
      include: { user: { include: { business: true } } },
    });
    expect(prisma.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'refresh-1' },
      data: { revokedAt: expect.any(Date) },
    });
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBeTruthy();
    expect(result.refreshToken).not.toBe(refreshToken);
  });
});
