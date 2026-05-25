import { Controller, Post, Body, Logger, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, req.ip, req.headers['user-agent']);
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, req.ip, req.headers['user-agent']);
  }

  @Post('refresh')
  async refresh(@Body() body: { refreshToken: string }, @Req() req: Request) {
    return this.authService.refresh(body.refreshToken, req.ip, req.headers['user-agent']);
  }

  @Post('logout')
  async logout(@Body() body: { refreshToken?: string }) {
    return this.authService.logout(body.refreshToken);
  }

  @Post('verify-reset-pin')
  async verifyResetPin(@Body() body: { identifier: string; pin: string }) {
    return this.authService.verifyResetPin(body.identifier, body.pin);
  }

  @Post('reset-password')
  async resetPassword(@Body() body: { identifier: string; newPassword: string; pin: string }) {
    return this.authService.resetPassword(body.identifier, body.newPassword, body.pin);
  }

  @Post('forgot-password')
  async forgotPassword(@Body() body: { email: string }) {
    return this.authService.forgotPassword(body.email);
  }
}
