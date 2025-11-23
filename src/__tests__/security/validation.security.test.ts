/**
 * Validation Security Test Suite
 *
 * CRITICAL: Input validation is the first line of defense against attacks
 * Coverage Target: 100% (statements, functions, lines, branches)
 *
 * Security Test Categories:
 * 1. Address Validation (8 tests)
 * 2. Amount Validation (7 tests)
 * 3. Deadline Validation (5 tests)
 * 4. Dispute Window Validation (6 tests)
 * 5. Transaction ID Validation (6 tests)
 *
 * References:
 * - Security Analysis: /Testnet/tests/SDK_SECURITY_ANALYSIS-Ultra-Think.md
 * - V3: Input Validation - Zero Address Bypass vulnerability
 */

import {
  validateAddress,
  validateAmount,
  validateDeadline,
  validateDisputeWindow,
  validateTxId
} from '../../utils/validation';

describe('Validation - Security Tests', () => {
  describe('validateAddress - Address Security', () => {
    it('should accept valid Ethereum address (lowercase)', () => {
      const validAddress = '0x742d35cc6634c0532925a3b844bc9e7595f0beb0';
      expect(() => validateAddress(validAddress)).not.toThrow();
    });

    it('should accept checksummed address', () => {
      const checksummedAddress = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
      expect(() => validateAddress(checksummedAddress)).not.toThrow();
    });

    it('should accept all lowercase address', () => {
      const lowercaseAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      expect(() => validateAddress(lowercaseAddress)).not.toThrow();
    });

    it('should reject zero address (0x0000...)', () => {
      const zeroAddress = '0x0000000000000000000000000000000000000000';
      expect(() => validateAddress(zeroAddress)).toThrow('zero address');
    });

    it('should reject invalid address format', () => {
      const invalidAddress = 'not-an-address';
      expect(() => validateAddress(invalidAddress)).toThrow('Invalid Ethereum address');
    });

    it('should reject address with invalid length', () => {
      const shortAddress = '0x742d35cc6634c053';
      expect(() => validateAddress(shortAddress)).toThrow('Invalid Ethereum address');
    });

    it('should reject non-hex characters in address', () => {
      const invalidHex = '0x742d35cc6634c0532925a3b844bc9e7595f0bebZ';
      expect(() => validateAddress(invalidHex)).toThrow('Invalid Ethereum address');
    });

    it('should reject empty string', () => {
      expect(() => validateAddress('')).toThrow('Invalid Ethereum address');
    });

    it('should reject null/undefined', () => {
      expect(() => validateAddress(null as any)).toThrow('Invalid Ethereum address');
      expect(() => validateAddress(undefined as any)).toThrow('Invalid Ethereum address');
    });

    it('should include address in error message', () => {
      try {
        validateAddress('invalid-addr', 'providerAddress');
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Invalid Ethereum address');
        expect(error.message).toContain('invalid-addr');
      }
    });

    it('should always use "address" as field name', () => {
      try {
        validateAddress('invalid');
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.details.field).toBe('address');
      }
    });
  });

  describe('validateAmount - Amount Security', () => {
    it('should accept positive amount', () => {
      const amount = BigInt('100000000');
      expect(() => validateAmount(amount)).not.toThrow();
    });

    it('should accept minimum amount (1 wei)', () => {
      const minAmount = BigInt(1);
      expect(() => validateAmount(minAmount)).not.toThrow();
    });

    it('should accept maximum uint256 amount', () => {
      const maxAmount = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
      expect(() => validateAmount(maxAmount)).not.toThrow();
    });

    it('should reject zero amount', () => {
      const zeroAmount = BigInt(0);
      expect(() => validateAmount(zeroAmount)).toThrow('must be > 0');
    });

    it('should reject negative amount', () => {
      const negativeAmount = BigInt(-1);
      expect(() => validateAmount(negativeAmount)).toThrow('Invalid amount');
    });

    it('should reject null/undefined', () => {
      expect(() => validateAmount(null as any)).toThrow('Invalid amount');
      expect(() => validateAmount(undefined as any)).toThrow('Invalid amount');
    });

    it('should include amount value in error message', () => {
      try {
        validateAmount(BigInt(0));
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('0');
      }
    });

    it('should always use "amount" as field name', () => {
      try {
        validateAmount(BigInt(0), 'escrowAmount');
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.details.field).toBe('amount');
      }
    });
  });

  describe('validateDeadline - Deadline Security', () => {
    it('should accept future deadline', () => {
      const futureDeadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      expect(() => validateDeadline(futureDeadline)).not.toThrow();
    });

    it('should accept deadline far in the future', () => {
      const farFuture = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60); // 1 year from now
      expect(() => validateDeadline(farFuture)).not.toThrow();
    });

    it('should reject past deadline', () => {
      const pastDeadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      expect(() => validateDeadline(pastDeadline)).toThrow('must be in the future');
    });

    it('should reject current timestamp (not in future)', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(() => validateDeadline(now)).toThrow('must be in the future');
    });

    it('should include current time and deadline in error message', () => {
      const pastDeadline = Math.floor(Date.now() / 1000) - 3600;
      try {
        validateDeadline(pastDeadline);
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('now:');
        expect(error.message).toContain('deadline:');
      }
    });

    it('should use field name parameter', () => {
      const past = Math.floor(Date.now() / 1000) - 1;
      expect(() => validateDeadline(past, 'transactionDeadline')).toThrow('must be in the future');
    });

    it('should use default field name when not provided', () => {
      const past = Math.floor(Date.now() / 1000) - 1;
      try {
        validateDeadline(past);
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('validateDisputeWindow - Dispute Window Security', () => {
    const MAX_DISPUTE_WINDOW = 30 * 24 * 60 * 60; // 30 days in seconds

    it('should accept valid dispute window (2 hours)', () => {
      const twoHours = 2 * 60 * 60;
      expect(() => validateDisputeWindow(twoHours)).not.toThrow();
    });

    it('should accept minimum dispute window (0 seconds)', () => {
      expect(() => validateDisputeWindow(0)).not.toThrow();
    });

    it('should accept maximum dispute window (30 days)', () => {
      expect(() => validateDisputeWindow(MAX_DISPUTE_WINDOW)).not.toThrow();
    });

    it('should accept typical 2-day dispute window', () => {
      const twoDays = 2 * 24 * 60 * 60;
      expect(() => validateDisputeWindow(twoDays)).not.toThrow();
    });

    it('should reject negative dispute window', () => {
      expect(() => validateDisputeWindow(-1)).toThrow('cannot be negative');
    });

    it('should reject dispute window exceeding 30 days', () => {
      const thirtyOneDays = 31 * 24 * 60 * 60;
      expect(() => validateDisputeWindow(thirtyOneDays)).toThrow('exceeds maximum');
    });

    it('should include maximum allowed value in error message', () => {
      const excessive = MAX_DISPUTE_WINDOW + 1;
      try {
        validateDisputeWindow(excessive);
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('30 days');
      }
    });

    it('should use field name parameter', () => {
      expect(() => validateDisputeWindow(-1, 'windowDuration')).toThrow('cannot be negative');
    });

    it('should use default field name when not provided', () => {
      try {
        validateDisputeWindow(-1);
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.details.field).toBe('disputeWindow');
      }
    });
  });

  describe('validateTxId - Transaction ID Security', () => {
    it('should accept valid bytes32 transaction ID', () => {
      const validTxId = '0x' + '1'.repeat(64);
      expect(() => validateTxId(validTxId)).not.toThrow();
    });

    it('should accept transaction ID with mixed hex characters', () => {
      const mixedTxId = '0x' + 'a1b2c3d4e5f6'.repeat(5) + '1234';
      expect(() => validateTxId(mixedTxId)).not.toThrow();
    });

    it('should accept uppercase hex characters', () => {
      const uppercaseTxId = '0x' + 'A'.repeat(64);
      expect(() => validateTxId(uppercaseTxId)).not.toThrow();
    });

    it('should reject invalid format (not bytes32)', () => {
      const invalidTxId = 'invalid-tx-id';
      expect(() => validateTxId(invalidTxId)).toThrow('Invalid transaction ID format');
    });

    it('should reject transaction ID with wrong length', () => {
      const shortTxId = '0x' + '1'.repeat(32); // Only 32 hex chars instead of 64
      expect(() => validateTxId(shortTxId)).toThrow('Invalid transaction ID format');
    });

    it('should reject transaction ID without 0x prefix', () => {
      const noPrefixTxId = '1'.repeat(64);
      expect(() => validateTxId(noPrefixTxId)).toThrow('Invalid transaction ID format');
    });

    it('should reject transaction ID with invalid hex characters', () => {
      const invalidHex = '0x' + '1'.repeat(63) + 'Z';
      expect(() => validateTxId(invalidHex)).toThrow('Invalid transaction ID format');
    });

    it('should reject empty string', () => {
      expect(() => validateTxId('')).toThrow('Invalid transaction ID format');
    });

    it('should reject null/undefined', () => {
      expect(() => validateTxId(null as any)).toThrow('Invalid transaction ID format');
      expect(() => validateTxId(undefined as any)).toThrow('Invalid transaction ID format');
    });

    it('should include expected format in error message', () => {
      try {
        validateTxId('invalid');
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('bytes32');
      }
    });

    it('should use field name parameter', () => {
      expect(() => validateTxId('invalid', 'transactionId')).toThrow('Invalid transaction ID format');
    });

    it('should use default field name when not provided', () => {
      try {
        validateTxId('invalid');
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.details.field).toBe('txId');
      }
    });
  });

  describe('Edge Cases - Cross-Function Validation', () => {
    it('should handle all validation functions with custom field names', () => {
      const validAddress = '0x742d35cc6634c0532925a3b844bc9e7595f0beb0';
      const validAmount = BigInt('100000000');
      const validDeadline = Math.floor(Date.now() / 1000) + 3600;
      const validDisputeWindow = 7200;
      const validTxId = '0x' + '1'.repeat(64);

      expect(() => validateAddress(validAddress, 'customAddress')).not.toThrow();
      expect(() => validateAmount(validAmount, 'customAmount')).not.toThrow();
      expect(() => validateDeadline(validDeadline, 'customDeadline')).not.toThrow();
      expect(() => validateDisputeWindow(validDisputeWindow, 'customWindow')).not.toThrow();
      expect(() => validateTxId(validTxId, 'customTxId')).not.toThrow();
    });

    it('should throw appropriate error types for each validator', () => {
      expect(() => validateAddress('invalid')).toThrow('Invalid Ethereum address');
      expect(() => validateAmount(BigInt(0))).toThrow('Invalid amount');
      expect(() => validateDeadline(0)).toThrow('must be in the future');
      expect(() => validateDisputeWindow(-1)).toThrow('cannot be negative');
      expect(() => validateTxId('invalid')).toThrow('Invalid transaction ID format');
    });

    it('should validate boundary conditions across all validators', () => {
      // Address: zero address is the boundary
      expect(() => validateAddress('0x0000000000000000000000000000000000000000')).toThrow();

      // Amount: 0 is the boundary (must be > 0)
      expect(() => validateAmount(BigInt(0))).toThrow();
      expect(() => validateAmount(BigInt(1))).not.toThrow();

      // Deadline: now is the boundary (must be in future)
      const now = Math.floor(Date.now() / 1000);
      expect(() => validateDeadline(now)).toThrow();
      expect(() => validateDeadline(now + 1)).not.toThrow();

      // Dispute window: 0 and 30 days are boundaries
      expect(() => validateDisputeWindow(-1)).toThrow();
      expect(() => validateDisputeWindow(0)).not.toThrow();
      expect(() => validateDisputeWindow(30 * 24 * 60 * 60)).not.toThrow();
      expect(() => validateDisputeWindow(30 * 24 * 60 * 60 + 1)).toThrow();
    });

    it('should preserve error details across all validators', () => {
      const testCases = [
        { fn: () => validateAddress('invalid', 'testAddress'), field: 'address' }, // InvalidAddressError hardcodes field
        { fn: () => validateAmount(BigInt(0), 'testAmount'), field: 'amount' }, // InvalidAmountError hardcodes field
        { fn: () => validateDeadline(0, 'testDeadline'), field: 'testDeadline' },
        { fn: () => validateDisputeWindow(-1, 'testWindow'), field: 'testWindow' },
        { fn: () => validateTxId('invalid', 'testTxId'), field: 'testTxId' }
      ];

      testCases.forEach(({ fn, field }) => {
        try {
          fn();
          fail('Should have thrown error');
        } catch (error: any) {
          expect(error.details).toBeDefined();
          expect(error.details.field).toBe(field);
        }
      });
    });
  });
});
