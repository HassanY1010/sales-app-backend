import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
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
  ['image/jpg', '.jpg'],
  ['image/pjpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
  ['application/octet-stream', '.jpg'],
]);

function ensureLogoUploadDir() {
  if (!existsSync(logoUploadDir)) {
    mkdirSync(logoUploadDir, { recursive: true });
  }
}

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

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
        const isAllowed = allowedLogoMimeTypes.has(file.mimetype) ||
          /\.(jpg|jpeg|png|webp|heic|heif)$/i.test(file.originalname || '');

        if (!isAllowed) {
          return callback(
            new BadRequestException(
              `Invalid file type (${file.mimetype}). Only JPG, PNG, and WEBP images are allowed.`,
            ),
            false,
          );
        }
        callback(null, true);
      },
      limits: {
        fileSize: 10 * 1024 * 1024, // 10 MB limit
        files: 1,
      },
    }),
  )
  async uploadLogo(@CurrentUser() user: any, @UploadedFile() file: any) {
    this.logger.log(`📸 Received uploadLogo request from userId: ${user.userId}`);
    return this.saveLogoFile(user.userId, file, 'logo');
  }

  @Post('me/avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      fileFilter: (
        _req: any,
        file: any,
        callback: (error: Error | null, acceptFile: boolean) => void,
      ) => {
        const isAllowed = allowedLogoMimeTypes.has(file.mimetype) ||
          /\.(jpg|jpeg|png|webp|heic|heif)$/i.test(file.originalname || '');

        if (!isAllowed) {
          return callback(
            new BadRequestException(
              `Invalid file type (${file.mimetype}). Only JPG, PNG, and WEBP images are allowed.`,
            ),
            false,
          );
        }
        callback(null, true);
      },
      limits: {
        fileSize: 10 * 1024 * 1024, // 10 MB limit
        files: 1,
      },
    }),
  )
  async uploadAvatar(@CurrentUser() user: any, @UploadedFile() file: any) {
    this.logger.log(`📸 Received uploadAvatar request from userId: ${user.userId}`);
    return this.saveLogoFile(user.userId, file, 'avatar');
  }

  private async saveLogoFile(userId: string, file: any, type: 'logo' | 'avatar') {
    if (!file?.buffer || !file?.mimetype) {
      this.logger.error(`❌ saveLogoFile failed: No file buffer or mimetype received for userId: ${userId}`);
      throw new BadRequestException('Image file is required');
    }

    this.logger.log(
      `📥 Processing file upload [${type}]: name=${file.originalname}, size=${file.size} bytes, mimetype=${file.mimetype}`,
    );

    let extension = allowedLogoMimeTypes.get(file.mimetype);
    if (!extension && file.originalname) {
      const match = file.originalname.match(/\.(jpg|jpeg|png|webp|heic|heif)$/i);
      if (match) {
        extension = `.${match[1].toLowerCase()}`;
      }
    }
    extension = extension || '.jpg';

    const filename = `${randomUUID()}${extension}`;
    const projectId = process.env.SUPABASE_PROJECT_ID;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_BUCKET || 'uploads';

    let fileUrl: string;

    if (projectId && serviceKey) {
      try {
        this.logger.log(`☁️ Uploading to Supabase bucket '${bucket}' as ${filename}...`);
        const uploadUrl = `https://${projectId}.supabase.co/storage/v1/object/${bucket}/${filename}`;
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': file.mimetype,
          },
          body: file.buffer,
        });

        if (!response.ok) {
          const errText = await response.text();
          this.logger.error(`❌ Supabase upload error: ${response.statusText} - ${errText}`);
          throw new Error(`Supabase upload failed: ${response.statusText} - ${errText}`);
        }

        fileUrl = `https://${projectId}.supabase.co/storage/v1/object/public/${bucket}/${filename}`;
        this.logger.log(`✅ Supabase upload success: ${fileUrl}`);
      } catch (error: any) {
        this.logger.error(`❌ Storage upload failed: ${error.message}`);
        throw new BadRequestException(`Failed to upload file to storage: ${error.message}`);
      }
    } else {
      ensureLogoUploadDir();
      const localPath = join(logoUploadDir, filename);
      await writeFile(localPath, file.buffer);
      fileUrl = `/uploads/logos/${filename}`;
      this.logger.log(`📁 Local storage upload success: saved to ${localPath}, url=${fileUrl}`);
    }

    if (type === 'logo') {
      const result = await this.usersService.updateBusinessLogo(userId, fileUrl);
      this.logger.log(`✅ Updated Business Logo in DB for userId: ${userId} -> ${fileUrl}`);
      return result;
    } else {
      const result = await this.usersService.updateUserAvatar(userId, fileUrl);
      this.logger.log(`✅ Updated User Avatar in DB for userId: ${userId} -> ${fileUrl}`);
      return result;
    }
  }
}
