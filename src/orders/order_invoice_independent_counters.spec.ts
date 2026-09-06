import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceNumberService } from '../common/invoice-number.service';
import { PrismaService } from '../database/prisma.service';

describe('Invoice and Order Number Counter Decoupling', () => {
  let invoiceNumberService: InvoiceNumberService;

  const mockDbCounters: Record<string, bigint> = {};

  const mockPrisma = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockImplementation(async (query: any, ...values: any[]) => {
      const queryString = query.raw ? query.raw.join(' ') : query.toString();
      
      if (queryString.includes('business_invoice_counter')) {
        const businessId = values[0] || 'biz-1';
        const current = mockDbCounters[`inv_${businessId}`] || BigInt(0);
        const next = current + BigInt(1);
        mockDbCounters[`inv_${businessId}`] = next;
        return [{ lastNum: next }];
      }

      if (queryString.includes('business_order_counter')) {
        const businessId = values[0] || 'biz-1';
        const current = mockDbCounters[`ord_${businessId}`] || BigInt(0);
        const next = current + BigInt(1);
        mockDbCounters[`ord_${businessId}`] = next;
        return [{ lastNum: next }];
      }

      return [];
    }),
  };

  beforeEach(async () => {
    Object.keys(mockDbCounters).forEach((k) => delete mockDbCounters[k]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceNumberService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    invoiceNumberService = module.get<InvoiceNumberService>(InvoiceNumberService);
  });

  it('should maintain independent counters for invoices and orders for the same business', async () => {
    const bizA = 'biz-A';

    // 1. Create 3 invoices -> should be 1, 2, 3
    const inv1 = await invoiceNumberService.getNextInvoiceNumber(bizA);
    const inv2 = await invoiceNumberService.getNextInvoiceNumber(bizA);
    const inv3 = await invoiceNumberService.getNextInvoiceNumber(bizA);

    expect(inv1).toBe('1');
    expect(inv2).toBe('2');
    expect(inv3).toBe('3');

    // 2. Create 2 orders -> should start at 1, 2 (NOT 4!)
    const ord1 = await invoiceNumberService.getNextOrderNumber(bizA);
    const ord2 = await invoiceNumberService.getNextOrderNumber(bizA);

    expect(ord1).toBe('1');
    expect(ord2).toBe('2');

    // 3. Create next invoice -> should continue to 4 (NOT 3)
    const inv4 = await invoiceNumberService.getNextInvoiceNumber(bizA);
    expect(inv4).toBe('4');

    // 4. Create next order -> should continue to 3 (NOT 5)
    const ord3 = await invoiceNumberService.getNextOrderNumber(bizA);
    expect(ord3).toBe('3');
  });

  it('should maintain independent counters across different businesses', async () => {
    const bizA = 'biz-A';
    const bizB = 'biz-B';

    const invA1 = await invoiceNumberService.getNextInvoiceNumber(bizA);
    const invA2 = await invoiceNumberService.getNextInvoiceNumber(bizA);

    const invB1 = await invoiceNumberService.getNextInvoiceNumber(bizB);
    const ordB1 = await invoiceNumberService.getNextOrderNumber(bizB);

    expect(invA1).toBe('1');
    expect(invA2).toBe('2');
    expect(invB1).toBe('1');
    expect(ordB1).toBe('1');
  });
});
