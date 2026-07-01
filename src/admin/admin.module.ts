import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdjustmentRequestsModule } from '../adjustment-requests/adjustment-requests.module';

@Module({
  imports: [
    DatabaseModule,
    EventsModule,
    NotificationsModule,
    AdjustmentRequestsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
