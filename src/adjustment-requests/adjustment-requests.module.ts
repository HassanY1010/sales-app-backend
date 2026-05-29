import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { FinanceModule } from '../finance/finance.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdjustmentRequestsController } from './adjustment-requests.controller';
import { AdjustmentRequestsService } from './adjustment-requests.service';

@Module({
  imports: [DatabaseModule, FinanceModule, NotificationsModule, EventsModule],
  controllers: [AdjustmentRequestsController],
  providers: [AdjustmentRequestsService],
  exports: [AdjustmentRequestsService],
})
export class AdjustmentRequestsModule {}
