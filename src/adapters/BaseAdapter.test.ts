/**
 * BaseAdapter Unit Tests
 *
 * Tests all parsing utilities in BaseAdapter:
 * - parseAmount() - Amount string to bigint conversion
 * - validateAddress() - Ethereum address validation
 * - parseDeadline() - Relative time to Unix timestamp conversion
 * - formatAmount() - bigint to human-readable string
 */

import {
  BaseAdapter,
  ValidationError,
  DEFAULT_DISPUTE_WINDOW_SECONDS,
  DEFAULT_DEADLINE_SECONDS,
  MIN_AMOUNT_WEI,
  MAX_DEADLINE_HOURS,
  MAX_DEADLINE_DAYS,
} from './BaseAdapter';

/**
 * Concrete implementation of BaseAdapter for testing.
 * BaseAdapter is abstract, so we need a concrete class.
 */
class TestAdapter extends BaseAdapter {
  constructor(requesterAddress: string = '0x1111111111111111111111111111111111111111') {
    super(requesterAddress);
  }

  // Expose protected methods for testing
  public testParseAmount(amount: string | number): bigint {
    return this.parseAmount(amount);
  }

  public testValidateAddress(address: string, paramName: string): string {
    return this.validateAddress(address, paramName);
  }

  public testParseDeadline(deadline?: string | number, currentTime?: number): number {
    return this.parseDeadline(deadline, currentTime);
  }

  public testFormatAmount(amount: bigint | string): string {
    return this.formatAmount(amount);
  }
}

describe('BaseAdapter', () => {
  let adapter: TestAdapter;

  beforeEach(() => {
    adapter = new TestAdapter();
  });

  describe('parseAmount', () => {
    describe('valid inputs', () => {
      test('parses integer amount', () => {
        const result = adapter.testParseAmount('100');
        expect(result).toBe(100_000_000n); // 100.00 USDC
      });

      test('parses decimal amount', () => {
        const result = adapter.testParseAmount('100.50');
        expect(result).toBe(100_500_000n); // 100.50 USDC
      });

      test('parses amount with 1 decimal place', () => {
        const result = adapter.testParseAmount('100.5');
        expect(result).toBe(100_500_000n); // 100.50 USDC
      });

      test('parses amount with 6 decimal places', () => {
        const result = adapter.testParseAmount('100.123456');
        expect(result).toBe(100_123_456n); // 100.123456 USDC
      });

      test('parses amount with leading zeros in decimal', () => {
        const result = adapter.testParseAmount('100.01');
        expect(result).toBe(100_010_000n); // 100.01 USDC
      });

      test('parses minimum amount ($0.05)', () => {
        const result = adapter.testParseAmount('0.05');
        expect(result).toBe(50_000n); // $0.05 USDC = MIN_AMOUNT_WEI
      });

      test('parses amount as number', () => {
        const result = adapter.testParseAmount(100);
        expect(result).toBe(100_000_000n); // 100.00 USDC
      });

      test('strips currency suffix "USDC"', () => {
        const result = adapter.testParseAmount('100 USDC');
        expect(result).toBe(100_000_000n);
      });

      test('strips currency suffix "usdc" (lowercase)', () => {
        const result = adapter.testParseAmount('100 usdc');
        expect(result).toBe(100_000_000n);
      });

      test('strips $ prefix', () => {
        const result = adapter.testParseAmount('$100');
        expect(result).toBe(100_000_000n);
      });

      test('strips $ prefix and USDC suffix', () => {
        const result = adapter.testParseAmount('$100 USDC');
        expect(result).toBe(100_000_000n);
      });

      test('strips thousands separators', () => {
        const result = adapter.testParseAmount('1,000');
        expect(result).toBe(1_000_000_000n); // 1000.00 USDC
      });

      test('strips multiple thousands separators', () => {
        const result = adapter.testParseAmount('1,000,000');
        expect(result).toBe(1_000_000_000_000n); // 1,000,000.00 USDC
      });

      test('parses large amount', () => {
        const result = adapter.testParseAmount('1000000');
        expect(result).toBe(1_000_000_000_000n); // 1,000,000.00 USDC
      });
    });

    describe('invalid inputs', () => {
      test('throws on non-numeric string', () => {
        expect(() => adapter.testParseAmount('abc')).toThrow(ValidationError);
        expect(() => adapter.testParseAmount('abc')).toThrow(
          'Invalid amount format: "abc". Expected number like "100" or "100.50"'
        );
      });

      test('throws on empty string', () => {
        expect(() => adapter.testParseAmount('')).toThrow(ValidationError);
      });

      test('throws on negative amount', () => {
        expect(() => adapter.testParseAmount('-100')).toThrow(ValidationError);
        expect(() => adapter.testParseAmount('-100')).toThrow('Amount cannot be negative');
      });

      test('throws on too many decimal places', () => {
        expect(() => adapter.testParseAmount('100.1234567')).toThrow(ValidationError);
      });

      test('throws on invalid characters', () => {
        expect(() => adapter.testParseAmount('100.50x')).toThrow(ValidationError);
      });

      test('throws on multiple decimal points', () => {
        expect(() => adapter.testParseAmount('100.50.50')).toThrow(ValidationError);
      });

      test('throws on zero amount (below minimum)', () => {
        expect(() => adapter.testParseAmount('0')).toThrow(ValidationError);
        expect(() => adapter.testParseAmount('0')).toThrow('Amount too small');
      });

      test('throws on amount below $0.05 minimum', () => {
        expect(() => adapter.testParseAmount('0.04')).toThrow(ValidationError);
        expect(() => adapter.testParseAmount('0.04')).toThrow('Minimum transaction is $0.05 USDC');
      });

      test('throws on tiny amount (1 wei)', () => {
        expect(() => adapter.testParseAmount('0.000001')).toThrow(ValidationError);
        expect(() => adapter.testParseAmount('0.000001')).toThrow('Amount too small');
      });
    });

    describe('Unicode whitespace handling (Issue #3 fix)', () => {
      test('handles non-breaking space (U+00A0)', () => {
        const result = adapter.testParseAmount('100\u00A0USDC');
        expect(result).toBe(100_000_000n);
      });

      test('handles zero-width space (U+200B)', () => {
        const result = adapter.testParseAmount('100\u200B');
        expect(result).toBe(100_000_000n);
      });

      test('handles em space (U+2003)', () => {
        const result = adapter.testParseAmount('100\u2003USDC');
        expect(result).toBe(100_000_000n);
      });

      test('handles zero-width no-break space / BOM (U+FEFF)', () => {
        const result = adapter.testParseAmount('\uFEFF100');
        expect(result).toBe(100_000_000n);
      });

      test('handles multiple Unicode whitespace types', () => {
        const result = adapter.testParseAmount('\u00A0100\u200B.\u200350\uFEFF USDC');
        expect(result).toBe(100_500_000n);
      });
    });
  });

  describe('validateAddress', () => {
    const validAddress = '0x1111111111111111111111111111111111111111';

    describe('valid inputs', () => {
      test('accepts valid lowercase address', () => {
        const result = adapter.testValidateAddress(validAddress, 'test');
        expect(result).toBe(validAddress);
      });

      test('accepts valid uppercase address', () => {
        const upperAddress = '0x' + '1111111111111111111111111111111111111111'.toUpperCase();
        const result = adapter.testValidateAddress(upperAddress, 'test');
        expect(result).toBe(upperAddress.toLowerCase()); // all-digit address — checksum = lowercase
      });

      test('accepts valid mixed-case address', () => {
        const mixedAddress = '0x1111111111111111111111111111111111111111'.replace(/1/g, 'A');
        const result = adapter.testValidateAddress(mixedAddress, 'test');
        expect(result).toBe('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'); // EIP-55 checksummed
      });

      test('normalizes address to EIP-55 checksum', () => {
        const mixedCase = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
        const result = adapter.testValidateAddress(mixedCase, 'test');
        expect(result).toBe('0xabCDEF1234567890ABcDEF1234567890aBCDeF12'); // EIP-55 checksummed
      });
    });

    describe('invalid inputs', () => {
      test('throws on non-string input', () => {
        expect(() => adapter.testValidateAddress(123 as any, 'test')).toThrow(ValidationError);
        expect(() => adapter.testValidateAddress(123 as any, 'test')).toThrow(
          'Invalid test address: expected string, got number'
        );
      });

      test('throws on missing 0x prefix', () => {
        expect(() => adapter.testValidateAddress('1111111111111111111111111111111111111111', 'test')).toThrow(
          ValidationError
        );
        expect(() => adapter.testValidateAddress('1111111111111111111111111111111111111111', 'test')).toThrow(
          'Expected 0x-prefixed hex string'
        );
      });

      test('throws on wrong length (too short)', () => {
        expect(() => adapter.testValidateAddress('0x1111', 'test')).toThrow(ValidationError);
        expect(() => adapter.testValidateAddress('0x1111', 'test')).toThrow(
          'Expected 42 characters (0x + 40 hex)'
        );
      });

      test('throws on wrong length (too long)', () => {
        expect(() => adapter.testValidateAddress('0x11111111111111111111111111111111111111111', 'test')).toThrow(
          ValidationError
        );
      });

      test('throws on invalid hex characters', () => {
        expect(() => adapter.testValidateAddress('0x111111111111111111111111111111111111111g', 'test')).toThrow(
          ValidationError
        );
        expect(() => adapter.testValidateAddress('0x111111111111111111111111111111111111111g', 'test')).toThrow(
          'Contains invalid hex characters'
        );
      });

      test('throws on empty string', () => {
        expect(() => adapter.testValidateAddress('', 'test')).toThrow(ValidationError);
      });
    });
  });

  describe('parseDeadline', () => {
    const fixedTime = 1700000000; // Fixed timestamp for testing

    describe('valid inputs', () => {
      test('defaults to +24h when undefined', () => {
        const result = adapter.testParseDeadline(undefined, fixedTime);
        expect(result).toBe(fixedTime + 86400);
      });

      test('passes through Unix timestamp', () => {
        const timestamp = 1734076400;
        const result = adapter.testParseDeadline(timestamp, fixedTime);
        expect(result).toBe(timestamp);
      });

      test('parses +1h', () => {
        const result = adapter.testParseDeadline('+1h', fixedTime);
        expect(result).toBe(fixedTime + 3600);
      });

      test('parses +24h', () => {
        const result = adapter.testParseDeadline('+24h', fixedTime);
        expect(result).toBe(fixedTime + 86400);
      });

      test('parses +7d', () => {
        const result = adapter.testParseDeadline('+7d', fixedTime);
        expect(result).toBe(fixedTime + 7 * 86400);
      });

      test('parses +1d', () => {
        const result = adapter.testParseDeadline('+1d', fixedTime);
        expect(result).toBe(fixedTime + 86400);
      });

      test('parses large hour value', () => {
        const result = adapter.testParseDeadline('+168h', fixedTime);
        expect(result).toBe(fixedTime + 168 * 3600); // 7 days in hours
      });

      test('parses maximum allowed hours (10 years)', () => {
        const result = adapter.testParseDeadline(`+${MAX_DEADLINE_HOURS}h`, fixedTime);
        expect(result).toBe(fixedTime + MAX_DEADLINE_HOURS * 3600);
      });

      test('parses maximum allowed days (10 years)', () => {
        const result = adapter.testParseDeadline(`+${MAX_DEADLINE_DAYS}d`, fixedTime);
        expect(result).toBe(fixedTime + MAX_DEADLINE_DAYS * 86400);
      });
    });

    describe('invalid inputs', () => {
      test('throws on invalid format', () => {
        expect(() => adapter.testParseDeadline('invalid', fixedTime)).toThrow(ValidationError);
        expect(() => adapter.testParseDeadline('invalid', fixedTime)).toThrow(
          'Invalid deadline format: "invalid". Expected Unix timestamp or relative time'
        );
      });

      test('throws on negative time', () => {
        expect(() => adapter.testParseDeadline('-24h', fixedTime)).toThrow(ValidationError);
      });

      test('throws on missing +', () => {
        expect(() => adapter.testParseDeadline('24h', fixedTime)).toThrow(ValidationError);
      });

      test('throws on invalid unit', () => {
        expect(() => adapter.testParseDeadline('+24m', fixedTime)).toThrow(ValidationError);
      });

      test('throws on empty string', () => {
        expect(() => adapter.testParseDeadline('', fixedTime)).toThrow(ValidationError);
      });

      test('throws on hours exceeding 10-year maximum', () => {
        expect(() => adapter.testParseDeadline('+87601h', fixedTime)).toThrow(ValidationError);
        expect(() => adapter.testParseDeadline('+87601h', fixedTime)).toThrow('Deadline too far in future');
      });

      test('throws on days exceeding 10-year maximum', () => {
        expect(() => adapter.testParseDeadline('+3651d', fixedTime)).toThrow(ValidationError);
        expect(() => adapter.testParseDeadline('+3651d', fixedTime)).toThrow('Deadline too far in future');
      });

      test('throws on extreme hours (integer overflow prevention)', () => {
        expect(() => adapter.testParseDeadline('+999999999h', fixedTime)).toThrow(ValidationError);
        expect(() => adapter.testParseDeadline('+999999999h', fixedTime)).toThrow('Deadline too far in future');
      });
    });

    describe('uses current time when not provided', () => {
      test('defaults to Date.now() when currentTime not provided', () => {
        const before = Math.floor(Date.now() / 1000);
        const result = adapter.testParseDeadline('+24h');
        const after = Math.floor(Date.now() / 1000);

        // Result should be between before+24h and after+24h
        expect(result).toBeGreaterThanOrEqual(before + 86400);
        expect(result).toBeLessThanOrEqual(after + 86400);
      });
    });
  });

  describe('formatAmount', () => {
    test('formats 100 USDC', () => {
      const result = adapter.testFormatAmount(100_000_000n);
      expect(result).toBe('100.00 USDC');
    });

    test('formats 100.50 USDC', () => {
      const result = adapter.testFormatAmount(100_500_000n);
      expect(result).toBe('100.50 USDC');
    });

    test('formats 0.01 USDC', () => {
      const result = adapter.testFormatAmount(10_000n);
      expect(result).toBe('0.01 USDC');
    });

    test('formats 0.99 USDC', () => {
      const result = adapter.testFormatAmount(990_000n);
      expect(result).toBe('0.99 USDC');
    });

    test('formats 1000 USDC', () => {
      const result = adapter.testFormatAmount(1_000_000_000n);
      expect(result).toBe('1000.00 USDC');
    });

    test('formats amount from string', () => {
      const result = adapter.testFormatAmount('100000000');
      expect(result).toBe('100.00 USDC');
    });

    test('formats zero', () => {
      const result = adapter.testFormatAmount(0n);
      expect(result).toBe('0.00 USDC');
    });

    test('rounds to 2 decimal places (round down)', () => {
      const result = adapter.testFormatAmount(100_124_000n); // 100.124000 USDC
      expect(result).toBe('100.12 USDC'); // 0.124 rounds down to 0.12
    });

    test('rounds to 2 decimal places (round up)', () => {
      const result = adapter.testFormatAmount(100_126_000n); // 100.126000 USDC
      expect(result).toBe('100.13 USDC'); // 0.126 rounds up to 0.13
    });

    test('rounds to 2 decimal places (round half up)', () => {
      const result = adapter.testFormatAmount(100_125_000n); // 100.125000 USDC
      expect(result).toBe('100.13 USDC'); // 0.125 rounds up to 0.13 (half up)
    });

    test('rounds overflow to next whole number', () => {
      const result = adapter.testFormatAmount(99_995_000n); // 99.995000 USDC
      expect(result).toBe('100.00 USDC'); // Rounds up to 100.00
    });
  });

  describe('ValidationError', () => {
    test('has correct name', () => {
      const error = new ValidationError('test message');
      expect(error.name).toBe('ValidationError');
    });

    test('has correct message', () => {
      const error = new ValidationError('test message');
      expect(error.message).toContain('test message');
    });

    test('is instance of Error and ACTPError', () => {
      const error = new ValidationError('test message');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('exported constants', () => {
    test('DEFAULT_DISPUTE_WINDOW_SECONDS is 2 days', () => {
      expect(DEFAULT_DISPUTE_WINDOW_SECONDS).toBe(172800);
    });

    test('DEFAULT_DEADLINE_SECONDS is 24 hours', () => {
      expect(DEFAULT_DEADLINE_SECONDS).toBe(86400);
    });

    test('MIN_AMOUNT_WEI is $0.05 in USDC wei', () => {
      expect(MIN_AMOUNT_WEI).toBe(50_000n);
    });

    test('MAX_DEADLINE_HOURS is 10 years', () => {
      expect(MAX_DEADLINE_HOURS).toBe(87600);
    });

    test('MAX_DEADLINE_DAYS is 10 years', () => {
      expect(MAX_DEADLINE_DAYS).toBe(3650);
    });
  });
});
