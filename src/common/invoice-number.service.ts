import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class InvoiceNumberService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generates the next sequential invoice number atomically for a specific business/user.
   * Starts at 1 for each user and increments sequentially without affecting other users.
   */
  async getNextInvoiceNumber(
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const client = (tx ?? this.prisma) as any;

    // Ensure the per-business counter table exists
    await client.$executeRaw`
      CREATE TABLE IF NOT EXISTS business_invoice_counter (
        "businessId" TEXT PRIMARY KEY,
        "lastNum" BIGINT NOT NULL DEFAULT 0
      )
    `;

    const result = await client.$queryRaw<{ lastNum: bigint }[]>`
      INSERT INTO business_invoice_counter ("businessId", "lastNum")
      VALUES (${businessId}, 1)
      ON CONFLICT ("businessId")
      DO UPDATE SET "lastNum" = business_invoice_counter."lastNum" + 1
      RETURNING "lastNum"
    `;

    const num = result[0]?.lastNum;
    if (num === undefined || num === null) {
      throw new Error('Failed to generate invoice number');
    }

    return num.toString();
  }

  /**
   * Peeks the upcoming next invoice number for a specific business without incrementing.
   */
  async peekNextInvoiceNumber(businessId: string): Promise<string> {
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS business_invoice_counter (
          "businessId" TEXT PRIMARY KEY,
          "lastNum" BIGINT NOT NULL DEFAULT 0
        )
      `;

      const rows = await this.prisma.$queryRaw<{ lastNum: bigint }[]>`
        SELECT "lastNum" FROM business_invoice_counter WHERE "businessId" = ${businessId}
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
   * Generates the next sequential voucher (receipt/payment) number for a specific business.
   * Starts at 1 for each user.
   */
  async getNextVoucherNumber(
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const client = (tx ?? this.prisma) as any;

    await client.$executeRaw`
      CREATE TABLE IF NOT EXISTS business_voucher_counter (
        "businessId" TEXT PRIMARY KEY,
        "lastNum" BIGINT NOT NULL DEFAULT 0
      )
    `;

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
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS business_voucher_counter (
          "businessId" TEXT PRIMARY KEY,
          "lastNum" BIGINT NOT NULL DEFAULT 0
        )
      `;

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
   */
  async getNextOrderNumber(
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const client = (tx ?? this.prisma) as any;

    await client.$executeRaw`
      CREATE TABLE IF NOT EXISTS business_order_counter (
        "businessId" TEXT PRIMARY KEY,
        "lastNum" BIGINT NOT NULL DEFAULT 0
      )
    `;

    const result = await client.$queryRaw<{ lastNum: bigint }[]>`
      INSERT INTO business_order_counter ("businessId", "lastNum")
      VALUES (${businessId}, 1)
      ON CONFLICT ("businessId")
      DO UPDATE SET "lastNum" = business_order_counter."lastNum" + 1
      RETURNING "lastNum"
    `;

    const num = result[0]?.lastNum;
    if (num === undefined || num === null) {
      throw new Error('Failed to generate order number');
    }

    return num.toString();
  }

  /**
   * Peeks the upcoming next order number for a specific business without incrementing.
   */
  async peekNextOrderNumber(businessId: string): Promise<string> {
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS business_order_counter (
          "businessId" TEXT PRIMARY KEY,
          "lastNum" BIGINT NOT NULL DEFAULT 0
        )
      `;

      const rows = await this.prisma.$queryRaw<{ lastNum: bigint }[]>`
        SELECT "lastNum" FROM business_order_counter WHERE "businessId" = ${businessId}
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
}

