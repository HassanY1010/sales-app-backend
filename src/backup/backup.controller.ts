import { Controller, Get, Post, Body, UseGuards, ForbiddenException } from '@nestjs/common';
import { BackupService } from './backup.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { CurrentUser } from '../core/decorators/current-user.decorator';

@Controller('api/v1/backup')
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
}
