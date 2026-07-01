import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  ForbiddenException,
  Query,
  Param,
} from '@nestjs/common';
import { BackupService } from './backup.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';

@Controller('backup')
@UseGuards(JwtAuthGuard)
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @Get('export')
  async export(@CurrentUser() user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.backupService.exportData(user.businessId);
  }

  @Post('restore')
  async restore(@CurrentUser() user: any, @Body() body: { data: any }) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
    return this.backupService.restoreData(user.businessId, body.data);
  }

  @Get('google/status')
  async googleStatus(@CurrentUser() user: any) {
    this.ensureBusiness(user);
    return this.backupService.getGoogleDriveStatus(user.businessId);
  }

  @Get('google/auth-url')
  async googleAuthUrl(
    @CurrentUser() user: any,
    @Query('redirectUri') redirectUri?: string,
  ) {
    this.ensureBusiness(user);
    return this.backupService.getGoogleAuthUrl(user.businessId, redirectUri);
  }

  @Post('google/connect')
  async googleConnect(
    @CurrentUser() user: any,
    @Body() body: { code: string; redirectUri?: string },
  ) {
    this.ensureBusiness(user);
    return this.backupService.connectGoogleDrive(
      user.businessId,
      user.userId,
      body.code,
      body.redirectUri,
    );
  }

  @Post('google/upload')
  async googleUpload(@CurrentUser() user: any) {
    this.ensureBusiness(user);
    return this.backupService.uploadToGoogleDrive(user.businessId, user.userId);
  }

  @Get('google/files')
  async googleFiles(@CurrentUser() user: any) {
    this.ensureBusiness(user);
    return this.backupService.listGoogleDriveBackups(user.businessId);
  }

  @Post('google/restore/:fileId')
  async googleRestore(
    @CurrentUser() user: any,
    @Param('fileId') fileId: string,
  ) {
    this.ensureBusiness(user);
    return this.backupService.restoreFromGoogleDrive(
      user.businessId,
      user.userId,
      fileId,
    );
  }

  private ensureBusiness(user: any) {
    if (!user.businessId) {
      throw new ForbiddenException('User does not have an associated business');
    }
  }
}
