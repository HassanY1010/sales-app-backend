import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';

const logoUploadDir = join(process.cwd(), 'uploads', 'logos');
const allowedLogoMimeTypes = new Map<string, string>([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

function ensureLogoUploadDir() {
  if (!existsSync(logoUploadDir)) {
    mkdirSync(logoUploadDir, { recursive: true });
  }
}

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
  async changePassword(
    @CurrentUser() user: any,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.usersService.changePassword(user.userId, dto);
  }

  @Post('me/change-pin')
  async changeSecurityPin(
    @CurrentUser() user: any,
    @Body() body: { pin: string },
  ) {
    return this.usersService.changeSecurityPin(user.userId, body.pin);
  }

  @Post('me/push-token')
  async updatePushToken(
    @CurrentUser() user: any,
    @Body() body: { pushToken: string },
  ) {
    return this.usersService.updatePushToken(user.userId, body.pushToken);
  }

  @Post('me/logo')
  @UseInterceptors(
    FileInterceptor('file', {
      fileFilter: (
        _req: any,
        file: any,
        callback: (error: Error | null, acceptFile: boolean) => void,
      ) => {
        if (!allowedLogoMimeTypes.has(file.mimetype)) {
          return callback(
            new BadRequestException(
              'Only JPG, PNG, and WEBP logo images are allowed',
            ),
            false,
          );
        }
        callback(null, true);
      },
      limits: {
        fileSize: 2 * 1024 * 1024,
        files: 1,
      },
    }),
  )
  async uploadLogo(@CurrentUser() user: any, @UploadedFile() file: any) {
    return this.saveLogoFile(user.userId, file);
  }

  @Post('me/avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      fileFilter: (
        _req: any,
        file: any,
        callback: (error: Error | null, acceptFile: boolean) => void,
      ) => {
        if (!allowedLogoMimeTypes.has(file.mimetype)) {
          return callback(
            new BadRequestException(
              'Only JPG, PNG, and WEBP logo images are allowed',
            ),
            false,
          );
        }
        callback(null, true);
      },
      limits: {
        fileSize: 2 * 1024 * 1024,
        files: 1,
      },
    }),
  )
  async uploadAvatar(@CurrentUser() user: any, @UploadedFile() file: any) {
    return this.saveLogoFile(user.userId, file);
  }

  private async saveLogoFile(userId: string, file: any) {
    if (!file?.buffer || !file?.mimetype) {
      throw new BadRequestException('Logo file is required');
    }

    const extension = allowedLogoMimeTypes.get(file.mimetype);
    if (!extension) {
      throw new BadRequestException(
        'Only JPG, PNG, and WEBP logo images are allowed',
      );
    }

    ensureLogoUploadDir();
    const filename = `${randomUUID()}${extension}`;
    await writeFile(join(logoUploadDir, filename), file.buffer);

    return this.usersService.updateBusinessLogo(
      userId,
      `/uploads/logos/${filename}`,
    );
  }
}
