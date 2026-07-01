import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ConnectionsModule } from './connections/connections.module';
import { OrdersModule } from './orders/orders.module';
import { TransactionsModule } from './transactions/transactions.module';
import { ReportsModule } from './reports/reports.module';
import { EventsModule } from './events/events.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ExpensesModule } from './expenses/expenses.module';
import { FinanceModule } from './finance/finance.module';
import { AdminModule } from './admin/admin.module';
import { BackupModule } from './backup/backup.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { BusinessesModule } from './businesses/businesses.module';
import { AuditModule } from './audit/audit.module';
import { AdjustmentRequestsModule } from './adjustment-requests/adjustment-requests.module';
import { DueRemindersModule } from './due-reminders/due-reminders.module';
import { RegionsModule } from './regions/regions.module';
import { AgentsModule } from './agents/agents.module';
import { CommissionsModule } from './commissions/commissions.module';
import { PayoutsModule } from './payouts/payouts.module';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100, // 100 requests per minute
      },
    ]),
    DatabaseModule,
    AuditModule,
    AuthModule,
    UsersModule,
    ConnectionsModule,
    OrdersModule,
    TransactionsModule,
    ReportsModule,
    EventsModule,
    NotificationsModule,
    ExpensesModule,
    FinanceModule,
    AdminModule,
    BackupModule,
    MonitoringModule,
    SubscriptionsModule,
    BusinessesModule,
    AdjustmentRequestsModule,
    DueRemindersModule,
    RegionsModule,
    AgentsModule,
    CommissionsModule,
    PayoutsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
