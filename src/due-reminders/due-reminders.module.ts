import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DueRemindersService } from './due-reminders.service';

@Module({
  imports: [DatabaseModule, NotificationsModule],
  providers: [DueRemindersService],
  exports: [DueRemindersService],
})
export class DueRemindersModule {}
