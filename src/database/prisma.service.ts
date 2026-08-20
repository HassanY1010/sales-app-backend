import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('✅ Database connected successfully');

      // Safe & Idempotent Backfill:
      // 1. Prefers Connection.pendingOpenBalance if set
      // 2. Otherwise picks the OLDEST opening ADJUSTMENT transaction (DISTINCT ON connectionId ORDER BY createdAt ASC)
      // 3. ONLY updates accounts where openingBalance IS NULL or 0
      // 4. Guarantees single-row match per connection and zero non-deterministic overwrites
      try {
        await this.$executeRawUnsafe(`
          UPDATE accounts a
          SET "openingBalance" = COALESCE(
            NULLIF(c."pendingOpenBalance", 0),
            sub.amount,
            0
          )
          FROM "Connection" c
          LEFT JOIN (
            SELECT DISTINCT ON ("connectionId") "connectionId", amount
            FROM "Transaction"
            WHERE "connectionId" IS NOT NULL
              AND "transactionType" = 'ADJUSTMENT'
              AND (note LIKE 'رصيد افتتاحي%' OR note LIKE '%افتتاحي%')
            ORDER BY "connectionId", "createdAt" ASC
          ) sub ON sub."connectionId" = c.id
          WHERE a."connectionId" = c.id
            AND (a."openingBalance" = 0 OR a."openingBalance" IS NULL)
            AND (c."pendingOpenBalance" > 0 OR sub.amount IS NOT NULL);
        `);
      } catch (backfillErr) {
        this.logger.warn('Legacy openingBalance backfill note: ' + backfillErr);
      }
    } catch (error) {
      this.logger.error('❌ Database connection failed', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
