import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { DatabaseModule } from '../database/database.module';
import { InvoiceNumberService } from '../common/invoice-number.service';

@Module({
  imports: [DatabaseModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, InvoiceNumberService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
