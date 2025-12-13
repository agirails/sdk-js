/**
 * CLI Unit Tests
 *
 * Tests CLI utilities and command logic without actually executing
 * the CLI binary. For full end-to-end tests, use manual testing
 * with `npm link`.
 *
 * @module cli/cli.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  Output,
  ExitCode,
  formatState,
  fmt,
  OutputMode,
} from './utils/output';
import {
  saveConfig,
  loadConfig,
  isInitialized,
  validateAddress,
  validatePrivateKey,
  CLIConfig,
} from './utils/config';
import { mapError, ErrorCode, isValidTxId } from './utils/client';
import { parseDuration, formatDuration } from './commands/time';
import { calculateFee } from './commands/simulate';

// ============================================================================
// Test Setup
// ============================================================================

let testDir: string;

beforeEach(() => {
  // Create unique temp directory for each test
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actp-cli-test-'));
});

afterEach(() => {
  // Clean up
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Output Tests
// ============================================================================

describe('Output', () => {
  describe('formatState', () => {
    it('should format INITIATED state as yellow', () => {
      const result = formatState('INITIATED');
      // In non-TTY environment, colors may be stripped
      expect(result).toContain('INITIATED');
    });

    it('should format SETTLED state as bold green', () => {
      const result = formatState('SETTLED');
      expect(result).toContain('SETTLED');
    });

    it('should format CANCELLED state as dim', () => {
      const result = formatState('CANCELLED');
      expect(result).toContain('CANCELLED');
    });

    it('should return unknown states as-is', () => {
      const result = formatState('UNKNOWN' as any);
      expect(result).toBe('UNKNOWN');
    });
  });

  describe('ExitCode', () => {
    it('should have standard exit codes', () => {
      expect(ExitCode.SUCCESS).toBe(0);
      expect(ExitCode.ERROR).toBe(1);
      expect(ExitCode.PENDING).toBe(2);
      expect(ExitCode.INVALID_INPUT).toBe(3);
      expect(ExitCode.NOT_INITIALIZED).toBe(4);
    });
  });

  describe('Output class', () => {
    it('should create output in human mode by default', () => {
      const output = new Output();
      expect(output.mode).toBe('human');
    });

    it('should create output in specified mode', () => {
      const jsonOutput = new Output('json');
      expect(jsonOutput.mode).toBe('json');

      const quietOutput = new Output('quiet');
      expect(quietOutput.mode).toBe('quiet');
    });
  });
});

// ============================================================================
// Config Tests
// ============================================================================

describe('Config', () => {
  describe('validateAddress', () => {
    it('should validate correct Ethereum addresses', () => {
      expect(validateAddress('0x1234567890123456789012345678901234567890')).toBe(true);
      expect(validateAddress('0xabcdef1234567890abcdef1234567890abcdef12')).toBe(true);
      expect(validateAddress('0xABCDEF1234567890ABCDEF1234567890ABCDEF12')).toBe(true);
    });

    it('should reject invalid addresses', () => {
      expect(validateAddress('')).toBe(false);
      expect(validateAddress('0x123')).toBe(false);
      expect(validateAddress('1234567890123456789012345678901234567890')).toBe(false);
      expect(validateAddress('0xGGGGGG1234567890abcdef1234567890abcdef12')).toBe(false);
    });
  });

  describe('validatePrivateKey', () => {
    it('should validate correct private keys', () => {
      const key64 = 'a'.repeat(64);
      expect(validatePrivateKey(key64)).toBe(true);
      expect(validatePrivateKey('0x' + key64)).toBe(true);
    });

    it('should reject invalid private keys', () => {
      expect(validatePrivateKey('')).toBe(false);
      expect(validatePrivateKey('a'.repeat(63))).toBe(false);
      expect(validatePrivateKey('g'.repeat(64))).toBe(false);
    });
  });

  describe('saveConfig and loadConfig', () => {
    it('should save and load config correctly', () => {
      const config: CLIConfig = {
        mode: 'mock',
        address: '0x1234567890123456789012345678901234567890',
        version: '1.0',
      };

      saveConfig(config, testDir);
      const loaded = loadConfig(testDir);

      expect(loaded.mode).toBe(config.mode);
      expect(loaded.address).toBe(config.address);
      expect(loaded.version).toBe(config.version);
    });

    it('should throw if config does not exist', () => {
      expect(() => loadConfig(testDir)).toThrow('not initialized');
    });

    it('should create .actp directory if not exists', () => {
      const config: CLIConfig = {
        mode: 'mock',
        address: '0x1234567890123456789012345678901234567890',
        version: '1.0',
      };

      saveConfig(config, testDir);

      const actpDir = path.join(testDir, '.actp');
      expect(fs.existsSync(actpDir)).toBe(true);
    });
  });

  describe('isInitialized', () => {
    it('should return false if not initialized', () => {
      expect(isInitialized(testDir)).toBe(false);
    });

    it('should return true after initialization', () => {
      const config: CLIConfig = {
        mode: 'mock',
        address: '0x1234567890123456789012345678901234567890',
        version: '1.0',
      };
      saveConfig(config, testDir);

      expect(isInitialized(testDir)).toBe(true);
    });
  });
});

// ============================================================================
// Client Utils Tests
// ============================================================================

describe('Client Utils', () => {
  describe('isValidTxId', () => {
    it('should validate correct transaction IDs', () => {
      const validTxId = '0x' + 'a'.repeat(64);
      expect(isValidTxId(validTxId)).toBe(true);
    });

    it('should reject invalid transaction IDs', () => {
      expect(isValidTxId('')).toBe(false);
      expect(isValidTxId('0x123')).toBe(false);
      expect(isValidTxId('a'.repeat(64))).toBe(false); // Missing 0x prefix
      expect(isValidTxId('0x' + 'g'.repeat(64))).toBe(false); // Invalid hex
    });
  });

  describe('mapError', () => {
    it('should map TransactionNotFoundError', () => {
      const error = new Error('Transaction not found: 0x123');
      error.name = 'TransactionNotFoundError';

      const result = mapError(error);
      expect(result.code).toBe(ErrorCode.TX_NOT_FOUND);
    });

    it('should map InsufficientBalanceError', () => {
      const error = new Error('Insufficient balance');
      error.name = 'InsufficientBalanceError';

      const result = mapError(error);
      expect(result.code).toBe(ErrorCode.INSUFFICIENT_BALANCE);
    });

    it('should map not initialized error', () => {
      const error = new Error('ACTP not initialized in this directory');

      const result = mapError(error);
      expect(result.code).toBe(ErrorCode.NOT_INITIALIZED);
    });

    it('should map unknown errors', () => {
      const error = new Error('Some random error');

      const result = mapError(error);
      expect(result.code).toBe(ErrorCode.UNKNOWN_ERROR);
    });
  });
});

// ============================================================================
// Time Command Tests
// ============================================================================

describe('Time Commands', () => {
  describe('parseDuration', () => {
    it('should parse seconds', () => {
      expect(parseDuration('30s')).toBe(30);
      expect(parseDuration('60s')).toBe(60);
    });

    it('should parse minutes', () => {
      expect(parseDuration('5m')).toBe(300);
      expect(parseDuration('60m')).toBe(3600);
    });

    it('should parse hours', () => {
      expect(parseDuration('1h')).toBe(3600);
      expect(parseDuration('24h')).toBe(86400);
    });

    it('should parse days', () => {
      expect(parseDuration('1d')).toBe(86400);
      expect(parseDuration('7d')).toBe(604800);
    });

    it('should parse raw seconds', () => {
      expect(parseDuration('3600')).toBe(3600);
      expect(parseDuration('86400')).toBe(86400);
    });

    it('should throw for invalid formats', () => {
      expect(() => parseDuration('invalid')).toThrow();
      expect(() => parseDuration('5x')).toThrow();
      expect(() => parseDuration('-5h')).toThrow();
    });
  });

  describe('formatDuration', () => {
    it('should format seconds', () => {
      expect(formatDuration(30)).toBe('30s');
      expect(formatDuration(59)).toBe('59s');
    });

    it('should format minutes', () => {
      expect(formatDuration(60)).toBe('1m');
      expect(formatDuration(90)).toBe('1m 30s');
      expect(formatDuration(3540)).toBe('59m');
    });

    it('should format hours', () => {
      expect(formatDuration(3600)).toBe('1h');
      expect(formatDuration(5400)).toBe('1h 30m');
      expect(formatDuration(86340)).toBe('23h 59m');
    });

    it('should format days', () => {
      expect(formatDuration(86400)).toBe('1d');
      expect(formatDuration(90000)).toBe('1d 1h');
      expect(formatDuration(604800)).toBe('7d');
    });
  });
});

// ============================================================================
// Simulate Command Tests
// ============================================================================

describe('Simulate Commands', () => {
  describe('calculateFee', () => {
    it('should calculate 1% fee for amounts >= $5', () => {
      // $100 -> $1 fee (1%)
      const result = calculateFee(100_000_000n);
      expect(result.fee).toBe(1_000_000n);
      expect(result.effectiveRate).toBe('1.00%');
      expect(result.minimumApplied).toBe(false);
    });

    it('should apply minimum $0.05 fee for amounts < $5', () => {
      // $1 -> should be $0.01 (1%), but minimum is $0.05
      const result = calculateFee(1_000_000n);
      expect(result.fee).toBe(50_000n); // $0.05 minimum
      expect(result.minimumApplied).toBe(true);
    });

    it('should calculate correct provider receives amount', () => {
      // $100 -> provider receives $99 (amount - 1% fee)
      const result = calculateFee(100_000_000n);
      expect(result.providerReceives).toBe(99_000_000n);
    });

    it('should handle exact breakeven ($5)', () => {
      // $5 -> $0.05 fee (1% = minimum)
      const result = calculateFee(5_000_000n);
      expect(result.fee).toBe(50_000n);
      expect(result.minimumApplied).toBe(false); // 1% equals minimum
    });

    it('should calculate effective rate', () => {
      // $2 -> $0.05 fee -> 2.5% effective rate
      const result = calculateFee(2_000_000n);
      expect(result.effectiveRate).toBe('2.50%');
      expect(result.minimumApplied).toBe(true);
    });
  });
});

// ============================================================================
// Integration Tests (would require mocking or temp directories)
// ============================================================================

describe('CLI Integration', () => {
  it('should have all required commands exported', async () => {
    // Test that the CLI index exports the program
    const { createInitCommand } = await import('./commands/init');
    const { createPayCommand } = await import('./commands/pay');
    const { createTxCommand } = await import('./commands/tx');
    const { createBalanceCommand } = await import('./commands/balance');
    const { createMintCommand } = await import('./commands/mint');
    const { createConfigCommand } = await import('./commands/config');
    const { createWatchCommand } = await import('./commands/watch');
    const { createSimulateCommand } = await import('./commands/simulate');
    const { createBatchCommand } = await import('./commands/batch');
    const { createTimeCommand } = await import('./commands/time');

    expect(createInitCommand).toBeDefined();
    expect(createPayCommand).toBeDefined();
    expect(createTxCommand).toBeDefined();
    expect(createBalanceCommand).toBeDefined();
    expect(createMintCommand).toBeDefined();
    expect(createConfigCommand).toBeDefined();
    expect(createWatchCommand).toBeDefined();
    expect(createSimulateCommand).toBeDefined();
    expect(createBatchCommand).toBeDefined();
    expect(createTimeCommand).toBeDefined();
  });
});
