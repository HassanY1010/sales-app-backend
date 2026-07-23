import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { EventsModule } from '../events/events.module';
import { InvoiceNumberService } from '../common/invoice-number.service';

@Module({
  imports: [DatabaseModule, NotificationsModule, EventsModule],
  controllers: [OrdersController],
  providers: [OrdersService, InvoiceNumberService],
  exports: [OrdersService],
})
export class OrdersModule {}
