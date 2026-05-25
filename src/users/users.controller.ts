import { Controller, Get, Patch, Post, Body, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getMe(@CurrentUser() user: any) {
    return this.usersService.getMe(user.userId);
  }

  @Patch('me')
  async updateProfile(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(user.userId, dto);
  }

  @Post('me/change-password')
  async changePassword(@CurrentUser() user: any, @Body() dto: ChangePasswordDto) {
    return this.usersService.changePassword(user.userId, dto);
  }

  @Post('me/change-pin')
  async changeSecurityPin(@CurrentUser() user: any, @Body() body: { pin: string }) {
    return this.usersService.changeSecurityPin(user.userId, body.pin);
  }

  @Post('me/push-token')
  async updatePushToken(@CurrentUser() user: any, @Body() body: { pushToken: string }) {
    return this.usersService.updatePushToken(user.userId, body.pushToken);
  }

  @Post('me/logo')
  @UseInterceptors(FileInterceptor('file'))
  async uploadLogo(@CurrentUser() user: any, @UploadedFile() file: any) {
    return { url: `/uploads/logos/${user.userId}_${file?.originalname}` };
  }
}
