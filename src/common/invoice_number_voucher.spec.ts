import { InvoiceNumberService } from './invoice-number.service';

describe('InvoiceNumberService - Voucher Number Sequence Verification', () => {
  let service: InvoiceNumberService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      $queryRawUnsafe: jest.fn(),
      $queryRaw: jest.fn(),
    };
    service = new InvoiceNumberService(mockPrisma);
  });

  describe('peekNextVoucherNumber', () => {
    it('should query transactions with senderId OR receiverId filter to cover receipt vouchers', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ peekNum: BigInt(2) }]);

      const result = await service.peekNextVoucherNumber('biz-123');

      expect(result).toBe('2');
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('"senderId" = $1 OR "receiverId" = $1'),
        'biz-123',
      );
    });

    it('should return "1" when no transactions and counter is empty', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ peekNum: BigInt(1) }]);

      const result = await service.peekNextVoucherNumber('biz-new');

      expect(result).toBe('1');
    });

    it('should return "1" on error fallback', async () => {
      mockPrisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('DB error'));

      const result = await service.peekNextVoucherNumber('biz-err');

      expect(result).toBe('1');
    });
  });

  describe('getNextVoucherNumber', () => {
    it('should use atomic UPSERT CTE checking both senderId and receiverId', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ lastNum: BigInt(2) }]);

      const result = await service.getNextVoucherNumber('biz-123');

      expect(result).toBe('2');
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('business_voucher_counter'),
        'biz-123',
      );
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('"senderId" = $1 OR "receiverId" = $1'),
        'biz-123',
      );
    });

    it('should fallback to MAX(voucherNumber) + 1 with senderId OR receiverId if counter table is missing', async () => {
      mockPrisma.$queryRawUnsafe
        .mockRejectedValueOnce(new Error('relation "business_voucher_counter" does not exist'))
        .mockResolvedValueOnce([{ max_num: BigInt(5) }]);

      const result = await service.getNextVoucherNumber('biz-123');

      expect(result).toBe('6');
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenLastCalledWith(
        expect.stringContaining('"senderId" = $1 OR "receiverId" = $1'),
        'biz-123',
      );
    });
  });
});
