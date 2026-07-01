import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

function extractCookieToken(request: any): string | null {
  const cookieHeader = request?.headers?.cookie;
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;

  const cookies = cookieHeader.split(';').map((cookie) => cookie.trim());
  const accessCookie = cookies.find((cookie) =>
    cookie.startsWith('access_token='),
  );
  if (!accessCookie) return null;

  return decodeURIComponent(accessCookie.slice('access_token='.length));
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private configService: ConfigService) {
    const secret = configService.get<string>('JWT_SECRET');
    if (!secret || secret.length < 32) {
      throw new Error(
        'JWT_SECRET must be configured with at least 32 characters',
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        extractCookieToken,
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: any) {
    if (
      !payload?.sub ||
      !payload?.tokenType ||
      payload.tokenType !== 'access'
    ) {
      throw new UnauthorizedException('Invalid token');
    }
    return {
      userId: payload.sub,
      email: payload.email,
      userType: payload.userType,
      role: payload.role,
      businessId: payload.businessId,
    };
  }
}
