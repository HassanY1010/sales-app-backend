import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class InvoiceNumberService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generates the next sequential invoice number atomically.
   * Uses PostgreSQL UPDATE ... RETURNING to prevent race conditions.
   *
   * MUST be called inside a Prisma $transaction when the caller
   * also creates an Order/Transaction in the same atomic block.
   *
   * @param tx - Optional Prisma transaction client. If provided, the
   *             counter update participates in the same transaction.
   * @returns The next invoice number as a string (e.g. "1", "2", "3")
   */
  async getNextInvoiceNumber(
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const client = (tx ?? this.prisma) as any;

    // Atomically increment the counter and return the new value.
    // The upsert ensures the seed row (id=1, lastNum=0) exists on first use.
    const result = await client.$queryRaw<{ lastNum: bigint }[]>`
      INSERT INTO invoice_counter (id, "lastNum")
      VALUES (1, 1)
      ON CONFLICT (id)
      DO UPDATE SET "lastNum" = invoice_counter."lastNum" + 1
      RETURNING "lastNum"
    `;

    const num = result[0]?.lastNum;
    if (num === undefined || num === null) {
      throw new Error('Failed to generate invoice number');
    }

    // BigInt → string (plain number, no prefix)
    return num.toString();
  }
}
