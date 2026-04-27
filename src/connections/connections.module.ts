import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ConnectionsService } from './connections.service';
import { ConnectionsController } from './connections.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [DatabaseModule, NotificationsModule, EventsModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
