import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class InvoiceNumberService {
  private static tablesInitialized = false;

  constructor(private readonly prisma: PrismaService) {
    this.ensureTablesExist().catch(() => {});
  }

  public async ensureTablesExist() {
    if (InvoiceNumberService.tablesInitialized) return;
    try {
      // Run each statement separately — multi-statement $executeRawUnsafe can fail on some PostgreSQL setups
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS business_invoice_counter (
          "businessId" TEXT PRIMARY KEY,
          "lastNum" BIGINT NOT NULL DEFAULT 0
        )
      `);
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS business_voucher_counter (
          "businessId" TEXT PRIMARY KEY,
          "lastNum" BIGINT NOT NULL DEFAULT 0
        )
      `);
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS business_order_counter (
          "businessId" TEXT PRIMARY KEY,
          "lastNum" BIGINT NOT NULL DEFAULT 0
        )
      `);
      InvoiceNumberService.tablesInitialized = true;
    } catch (err) {
      // Log the error but don't throw — fallback logic exists in each counter method
      console.error('[InvoiceNumberService] Failed to create counter tables:', err?.message);
    }
  }

  /**
   * Generates the next sequential invoice number atomically for a specific business/user.
   * Uses PostgreSQL row locking and UPSERT with MAX(orderNumber) synchronization to guarantee:
   * 1. Concurrency safety (atomic row update in DB)
   * 2. Counter is always strictly > any existing numeric orderNumber for this sender
   * 3. No duplicate (senderId, orderNumber) collisions
   */
  async getNextInvoiceNumber(
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    // Ensure tables exist before querying (static flag makes this a no-op after first call)
    await this.ensureTablesExist();
    const client = (tx ?? this.prisma) as any;

    try {
      const result = (await client.$queryRawUnsafe(
        `
        WITH current_max AS (
          SELECT COALESCE(
            MAX(
              CASE 
                WHEN "orderNumber" ~ '^[0-9]+$' THEN "orderNumber"::BIGINT 
                ELSE 0 
              END
            ), 
            0
          ) AS max_num
          FROM orders
          WHERE "senderId" = $1
        )
        INSERT INTO business_invoice_counter ("businessId", "lastNum")
        SELECT $1, GREATEST(1, max_num + 1)
        FROM current_max
        ON CONFLICT ("businessId")
        DO UPDATE SET "lastNum" = (
          SELECT GREATEST(
            business_invoice_counter."lastNum" + 1,
            current_max.max_num + 1
          )
          FROM current_max
        )
        RETURNING "lastNum";
        `,
        businessId,
      )) as { lastNum: bigint }[];

      const num = result[0]?.lastNum;
      if (num === undefined || num === null) {
        throw new Error('Failed to generate invoice number');
      }
      return num.toString();
    } catch (err: any) {
      // If counter table still missing, fallback to MAX(orderNumber) + 1
      if (err?.message?.includes('business_invoice_counter') || err?.message?.includes('does not exist')) {
        const rows = await this.prisma.$queryRawUnsafe<{ max_num: bigint }[]>(
          `SELECT COALESCE(MAX(CASE WHEN "orderNumber" ~ '^[0-9]+$' THEN "orderNumber"::BIGINT ELSE 0 END), 0) AS max_num FROM orders WHERE "senderId" = $1`,
          businessId,
        );
        return ((rows[0]?.max_num ?? BigInt(0)) + BigInt(1)).toString();
      }
      throw err;
    }
  }

  /**
   * Peeks the upcoming next invoice number for a specific business without incrementing.
   */
  async peekNextInvoiceNumber(businessId: string): Promise<string> {
    try {
      const rows = (await this.prisma.$queryRawUnsafe(
        `
        WITH current_max AS (
          SELECT COALESCE(
            MAX(
              CASE 
                WHEN "orderNumber" ~ '^[0-9]+$' THEN "orderNumber"::BIGINT 
                ELSE 0 
              END
            ), 
            0
          ) AS max_num
          FROM orders
          WHERE "senderId" = $1
        ),
        counter AS (
          SELECT "lastNum"
          FROM business_invoice_counter
          WHERE "businessId" = $1
        )
        SELECT GREATEST(
          COALESCE((SELECT "lastNum" + 1 FROM counter), 1),
          (SELECT max_num + 1 FROM current_max)
        ) AS peekNum;
        `,
        businessId,
      )) as { peekNum: bigint }[];

      const peekNum = rows[0]?.peekNum;
      if (peekNum === undefined || peekNum === null) {
        return '1';
      }
      return peekNum.toString();
    } catch {
      return '1';
    }
  }

  /**
   * Generates the next sequential voucher (receipt/payment) number for a specific business.
   * Starts at 1 for each user.
   */
  async getNextVoucherNumber(
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const client = (tx ?? this.prisma) as any;

    const result = await client.$queryRaw<{ lastNum: bigint }[]>`
      INSERT INTO business_voucher_counter ("businessId", "lastNum")
      VALUES (${businessId}, 1)
      ON CONFLICT ("businessId")
      DO UPDATE SET "lastNum" = business_voucher_counter."lastNum" + 1
      RETURNING "lastNum"
    `;

    const num = result[0]?.lastNum;
    if (num === undefined || num === null) {
      throw new Error('Failed to generate voucher number');
    }

    return num.toString();
  }

  /**
   * Peeks the upcoming next voucher number for a specific business without incrementing.
   */
  async peekNextVoucherNumber(businessId: string): Promise<string> {
    try {
      const rows = await this.prisma.$queryRaw<{ lastNum: bigint }[]>`
        SELECT "lastNum" FROM business_voucher_counter WHERE "businessId" = ${businessId}
      `;
      const lastNum = rows[0]?.lastNum;
      if (lastNum === undefined || lastNum === null) {
        return '1';
      }
      return (BigInt(lastNum) + BigInt(1)).toString();
    } catch {
      return '1';
    }
  }

  /**
   * Generates the next sequential order (purchase order) number atomically for a specific business.
   * Starts at 1 for each user and increments sequentially without affecting invoices or vouchers.
   * Also synchronizes against existing order numbers to prevent collision.
   */
  async getNextOrderNumber(
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    // Ensure tables exist before querying (static flag makes this a no-op after first call)
    await this.ensureTablesExist();
    const client = (tx ?? this.prisma) as any;

    try {
      const result = (await client.$queryRawUnsafe(
        `
        WITH current_max AS (
          SELECT COALESCE(
            MAX(
              CASE 
                WHEN "orderNumber" ~ '^[0-9]+$' THEN "orderNumber"::BIGINT 
                ELSE 0 
              END
            ), 
            0
          ) AS max_num
          FROM orders
          WHERE "senderId" = $1
        )
        INSERT INTO business_order_counter ("businessId", "lastNum")
        SELECT $1, GREATEST(1, max_num + 1)
        FROM current_max
        ON CONFLICT ("businessId")
        DO UPDATE SET "lastNum" = (
          SELECT GREATEST(
            business_order_counter."lastNum" + 1,
            current_max.max_num + 1
          )
          FROM current_max
        )
        RETURNING "lastNum";
        `,
        businessId,
      )) as { lastNum: bigint }[];

      const num = result[0]?.lastNum;
      if (num === undefined || num === null) {
        throw new Error('Failed to generate order number');
      }
      return num.toString();
    } catch (err: any) {
      // If counter table still missing, fallback to MAX(orderNumber) + 1
      if (err?.message?.includes('business_order_counter') || err?.message?.includes('does not exist')) {
        const rows = await this.prisma.$queryRawUnsafe<{ max_num: bigint }[]>(
          `SELECT COALESCE(MAX(CASE WHEN "orderNumber" ~ '^[0-9]+$' THEN "orderNumber"::BIGINT ELSE 0 END), 0) AS max_num FROM orders WHERE "senderId" = $1`,
          businessId,
        );
        return ((rows[0]?.max_num ?? BigInt(0)) + BigInt(1)).toString();
      }
      throw err;
    }
  }

  /**
   * Peeks the upcoming next order number for a specific business without incrementing.
   */
  async peekNextOrderNumber(businessId: string): Promise<string> {
    try {
      const rows = (await this.prisma.$queryRawUnsafe(
        `
        WITH current_max AS (
          SELECT COALESCE(
            MAX(
              CASE 
                WHEN "orderNumber" ~ '^[0-9]+$' THEN "orderNumber"::BIGINT 
                ELSE 0 
              END
            ), 
            0
          ) AS max_num
          FROM orders
          WHERE "senderId" = $1
        ),
        counter AS (
          SELECT "lastNum"
          FROM business_order_counter
          WHERE "businessId" = $1
        )
        SELECT GREATEST(
          COALESCE((SELECT "lastNum" + 1 FROM counter), 1),
          (SELECT max_num + 1 FROM current_max)
        ) AS peekNum;
        `,
        businessId,
      )) as { peekNum: bigint }[];

      const peekNum = rows[0]?.peekNum;
      if (peekNum === undefined || peekNum === null) {
        return '1';
      }
      return peekNum.toString();
    } catch {
      return '1';
    }
  }
}

