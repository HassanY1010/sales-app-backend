import { Controller, Post, Body, Logger } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Controller('api/v1/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
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
