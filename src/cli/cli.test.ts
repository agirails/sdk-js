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

// ============================================================================
// Batch Command Security Tests (CRITICAL)
// ============================================================================

describe('Batch Command Security', () => {
  // Import batch internals for testing
  // We need to test the security functions directly

  const VALID_SUBCOMMANDS = new Set([
    'init', 'pay', 'tx', 'balance', 'mint', 'config',
    'watch', 'simulate', 'time',
  ]);

  const VALID_TX_SUBCOMMANDS = new Set([
    'create', 'status', 'list', 'deliver', 'settle', 'cancel',
  ]);

  const DANGEROUS_CHARS_PATTERN = /[;&|`$(){}[\]<>!\\'"]/;

  // Replicate parseCommandArgs for testing (from batch.ts)
  function parseCommandArgs(command: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    const cleanCommand = command.replace(/"[^"]*"|'[^']*'/g, '');
    if (DANGEROUS_CHARS_PATTERN.test(cleanCommand)) {
      throw new Error(
        'Command contains potentially dangerous characters. ' +
        'Shell metacharacters are not allowed for security reasons.'
      );
    }

    for (let i = 0; i < command.length; i++) {
      const char = command[i];

      if (inQuotes) {
        if (char === quoteChar) {
          inQuotes = false;
          quoteChar = '';
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        inQuotes = true;
        quoteChar = char;
      } else if (char === ' ' || char === '\t') {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      args.push(current);
    }

    if (inQuotes) {
      throw new Error('Unclosed quote in command');
    }

    return args;
  }

  function validateCommand(args: string[]): boolean {
    if (args.length === 0) {
      throw new Error('Empty command');
    }

    const subcommand = args[0];

    if (subcommand === 'tx') {
      if (args.length < 2) {
        throw new Error('tx command requires a subcommand');
      }
      if (!VALID_TX_SUBCOMMANDS.has(args[1])) {
        throw new Error(`Unknown tx subcommand: ${args[1]}`);
      }
      return true;
    }

    if (!VALID_SUBCOMMANDS.has(subcommand)) {
      throw new Error(`Unknown command: ${subcommand}`);
    }

    return true;
  }

  describe('parseCommandArgs', () => {
    it('should parse simple commands', () => {
      expect(parseCommandArgs('pay 0x123 100')).toEqual(['pay', '0x123', '100']);
      expect(parseCommandArgs('tx status abc')).toEqual(['tx', 'status', 'abc']);
    });

    it('should handle quoted arguments', () => {
      expect(parseCommandArgs('pay 0x123 "100 USDC"')).toEqual(['pay', '0x123', '100 USDC']);
      expect(parseCommandArgs("pay 0x123 '100 USDC'")).toEqual(['pay', '0x123', '100 USDC']);
    });

    it('should handle multiple spaces', () => {
      expect(parseCommandArgs('pay    0x123    100')).toEqual(['pay', '0x123', '100']);
    });

    it('should handle tabs', () => {
      expect(parseCommandArgs('pay\t0x123\t100')).toEqual(['pay', '0x123', '100']);
    });

    // SECURITY: Shell injection prevention tests
    describe('shell injection prevention', () => {
      it('should reject semicolon (command chaining)', () => {
        expect(() => parseCommandArgs('pay 0x123 100; rm -rf /')).toThrow('dangerous characters');
      });

      it('should reject ampersand (background/AND)', () => {
        expect(() => parseCommandArgs('pay 0x123 100 && echo pwned')).toThrow('dangerous characters');
        expect(() => parseCommandArgs('pay 0x123 100 & echo pwned')).toThrow('dangerous characters');
      });

      it('should reject pipe (command piping)', () => {
        expect(() => parseCommandArgs('pay 0x123 100 | cat /etc/passwd')).toThrow('dangerous characters');
      });

      it('should reject backticks (command substitution)', () => {
        expect(() => parseCommandArgs('pay 0x123 `whoami`')).toThrow('dangerous characters');
      });

      it('should reject dollar sign (variable expansion)', () => {
        expect(() => parseCommandArgs('pay 0x123 $HOME')).toThrow('dangerous characters');
        expect(() => parseCommandArgs('pay 0x123 $(whoami)')).toThrow('dangerous characters');
      });

      it('should reject parentheses (subshell)', () => {
        expect(() => parseCommandArgs('pay 0x123 (echo pwned)')).toThrow('dangerous characters');
      });

      it('should reject curly braces (brace expansion)', () => {
        expect(() => parseCommandArgs('pay 0x123 {a,b,c}')).toThrow('dangerous characters');
      });

      it('should reject square brackets (glob patterns)', () => {
        expect(() => parseCommandArgs('pay 0x123 [abc]')).toThrow('dangerous characters');
      });

      it('should reject redirects', () => {
        expect(() => parseCommandArgs('pay 0x123 > /tmp/output')).toThrow('dangerous characters');
        expect(() => parseCommandArgs('pay 0x123 < /etc/passwd')).toThrow('dangerous characters');
      });

      it('should reject exclamation mark (history expansion)', () => {
        expect(() => parseCommandArgs('pay 0x123 !!')).toThrow('dangerous characters');
      });

      it('should reject backslash (escape sequences)', () => {
        expect(() => parseCommandArgs('pay 0x123 \\n')).toThrow('dangerous characters');
      });

      it('should allow dangerous chars inside quotes (they are literal)', () => {
        // Inside quotes, these are literal strings, not shell metacharacters
        expect(parseCommandArgs('pay 0x123 "hello; world"')).toEqual(['pay', '0x123', 'hello; world']);
        expect(parseCommandArgs("pay 0x123 'hello && world'")).toEqual(['pay', '0x123', 'hello && world']);
      });
    });

    it('should throw on unclosed quotes', () => {
      // Note: unclosed quotes are caught by dangerous chars check first (quote char is in pattern)
      // This is still safe - the command is rejected
      expect(() => parseCommandArgs('pay 0x123 "unclosed')).toThrow();
      expect(() => parseCommandArgs("pay 0x123 'unclosed")).toThrow();
    });
  });

  describe('validateCommand', () => {
    it('should accept valid top-level commands', () => {
      expect(validateCommand(['init'])).toBe(true);
      expect(validateCommand(['pay', '0x123', '100'])).toBe(true);
      expect(validateCommand(['balance'])).toBe(true);
      expect(validateCommand(['mint', '0x123', '1000'])).toBe(true);
      expect(validateCommand(['config'])).toBe(true);
      expect(validateCommand(['watch', '0x123'])).toBe(true);
      expect(validateCommand(['simulate'])).toBe(true);
      expect(validateCommand(['time'])).toBe(true);
    });

    it('should accept valid tx subcommands', () => {
      expect(validateCommand(['tx', 'create', '0x123', '100'])).toBe(true);
      expect(validateCommand(['tx', 'status', '0x123'])).toBe(true);
      expect(validateCommand(['tx', 'list'])).toBe(true);
      expect(validateCommand(['tx', 'deliver', '0x123'])).toBe(true);
      expect(validateCommand(['tx', 'settle', '0x123'])).toBe(true);
      expect(validateCommand(['tx', 'cancel', '0x123'])).toBe(true);
    });

    it('should reject unknown commands', () => {
      expect(() => validateCommand(['rm'])).toThrow('Unknown command');
      expect(() => validateCommand(['cat'])).toThrow('Unknown command');
      expect(() => validateCommand(['curl'])).toThrow('Unknown command');
      expect(() => validateCommand(['wget'])).toThrow('Unknown command');
      expect(() => validateCommand(['bash'])).toThrow('Unknown command');
      expect(() => validateCommand(['sh'])).toThrow('Unknown command');
      expect(() => validateCommand(['node'])).toThrow('Unknown command');
    });

    it('should reject unknown tx subcommands', () => {
      expect(() => validateCommand(['tx', 'delete'])).toThrow('Unknown tx subcommand');
      expect(() => validateCommand(['tx', 'drop'])).toThrow('Unknown tx subcommand');
      expect(() => validateCommand(['tx', 'exec'])).toThrow('Unknown tx subcommand');
    });

    it('should reject empty command', () => {
      expect(() => validateCommand([])).toThrow('Empty command');
    });

    it('should reject tx without subcommand', () => {
      expect(() => validateCommand(['tx'])).toThrow('tx command requires a subcommand');
    });

    // SECURITY: Batch command doesn't include itself to prevent recursion
    it('should not allow batch command (no recursion)', () => {
      expect(() => validateCommand(['batch'])).toThrow('Unknown command');
    });
  });
});

// ============================================================================
// Client Utility Tests (Additional)
// ============================================================================

describe('Client Utils (Additional)', () => {
  describe('formatAddress', () => {
    // Import from client
    const { formatAddress } = require('./utils/client');

    it('should truncate long addresses', () => {
      const address = '0x1234567890123456789012345678901234567890';
      const formatted = formatAddress(address, 6);
      expect(formatted).toBe('0x123456...567890');
    });

    it('should not truncate short addresses', () => {
      const address = '0x1234';
      expect(formatAddress(address, 10)).toBe('0x1234');
    });

    it('should use default length of 10', () => {
      const address = '0x1234567890123456789012345678901234567890';
      const formatted = formatAddress(address);
      expect(formatted).toBe('0x1234567890...1234567890');
    });
  });

  describe('formatTxId', () => {
    const { formatTxId } = require('./utils/client');

    it('should truncate transaction IDs', () => {
      const txId = '0x' + 'a'.repeat(64);
      const formatted = formatTxId(txId, 8);
      expect(formatted).toBe('0xaaaaaaaa...');
    });

    it('should use default length of 8', () => {
      const txId = '0x' + 'b'.repeat(64);
      const formatted = formatTxId(txId);
      expect(formatted).toBe('0xbbbbbbbb...');
    });
  });

  describe('mapError (additional cases)', () => {
    it('should map config corrupted error', () => {
      const error = new Error('Config file corrupted or invalid');
      const result = mapError(error);
      expect(result.code).toBe('CONFIG_CORRUPTED');
    });

    it('should map invalid state transition error', () => {
      const error = new Error('Invalid state transition');
      error.name = 'InvalidStateTransitionError';
      const result = mapError(error);
      expect(result.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('should map deadline passed error', () => {
      const error = new Error('Deadline passed');
      error.name = 'DeadlinePassedError';
      const result = mapError(error);
      expect(result.code).toBe('DEADLINE_PASSED');
    });

    it('should map dispute window error', () => {
      const error = new Error('Dispute window is active');
      error.name = 'DisputeWindowActiveError';
      const result = mapError(error);
      expect(result.code).toBe('DISPUTE_WINDOW_ACTIVE');
    });

    it('should map file lock error', () => {
      const error = new Error('Could not acquire lock on file');
      const result = mapError(error);
      expect(result.code).toBe('FILE_LOCK_ERROR');
    });

    it('should sanitize paths in error messages', () => {
      const home = require('os').homedir();
      const error = new Error(`File not found: ${home}/secret/file.txt`);
      const result = mapError(error);
      expect(result.message).not.toContain(home);
      expect(result.message).toContain('~/secret/file.txt');
    });
  });
});

// ============================================================================
// Init Command Tests
// ============================================================================

describe('Init Command', () => {
  const { runInit } = require('./commands/init');
  require('../runtime/MockStateManager'); // Ensure module is loaded

  // Create a mock output that captures calls
  function createMockOutput() {
    const calls: { method: string; args: any[] }[] = [];
    return {
      calls,
      info: jest.fn((...args) => calls.push({ method: 'info', args })),
      success: jest.fn((...args) => calls.push({ method: 'success', args })),
      warning: jest.fn((...args) => calls.push({ method: 'warning', args })),
      error: jest.fn((...args) => calls.push({ method: 'error', args })),
      print: jest.fn((...args) => calls.push({ method: 'print', args })),
      blank: jest.fn(() => calls.push({ method: 'blank', args: [] })),
      result: jest.fn((...args) => calls.push({ method: 'result', args })),
      errorResult: jest.fn((...args) => calls.push({ method: 'errorResult', args })),
      mode: 'human' as const,
    };
  }

  it('should initialize in mock mode with generated address', async () => {
    const mockOutput = createMockOutput();
    const originalCwd = process.cwd();

    try {
      process.chdir(testDir);

      await runInit({ mode: 'mock' }, mockOutput);

      // Check that config was created
      const configPath = path.join(testDir, '.actp', 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      // Check that mock state was created
      const statePath = path.join(testDir, '.actp', 'mock-state.json');
      expect(fs.existsSync(statePath)).toBe(true);

      // Check output calls
      expect(mockOutput.success).toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should reject invalid mode', async () => {
    const mockOutput = createMockOutput();
    const originalCwd = process.cwd();

    try {
      process.chdir(testDir);

      await expect(runInit({ mode: 'invalid' }, mockOutput)).rejects.toThrow('Invalid mode');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should require password for testnet wallet generation', async () => {
    const mockOutput = createMockOutput();
    const originalCwd = process.cwd();
    const origTTY = process.stdin.isTTY;

    try {
      process.chdir(testDir);
      // Force non-TTY so promptPassword() returns '' immediately
      (process.stdin as any).isTTY = false;
      delete process.env.ACTP_KEY_PASSWORD;

      await expect(runInit({ mode: 'testnet' }, mockOutput)).rejects.toThrow('Wallet password required');
    } finally {
      (process.stdin as any).isTTY = origTTY;
      process.chdir(originalCwd);
    }
  });

  it('should reject invalid address format', async () => {
    const mockOutput = createMockOutput();
    const originalCwd = process.cwd();

    try {
      process.chdir(testDir);

      await expect(
        runInit({ mode: 'mock', address: 'invalid-address' }, mockOutput)
      ).rejects.toThrow('Invalid address format');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should require --force to reinitialize', async () => {
    const mockOutput = createMockOutput();
    const originalCwd = process.cwd();

    try {
      process.chdir(testDir);

      // First init
      await runInit({ mode: 'mock' }, mockOutput);

      // Second init without force should fail
      await expect(runInit({ mode: 'mock' }, mockOutput)).rejects.toThrow('already initialized');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should allow reinit with --force', async () => {
    const mockOutput = createMockOutput();
    const originalCwd = process.cwd();

    try {
      process.chdir(testDir);

      // First init
      await runInit({ mode: 'mock' }, mockOutput);

      // Second init with force should succeed
      await runInit({ mode: 'mock', force: true }, mockOutput);

      expect(mockOutput.success).toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

// ============================================================================
// Output Utility Tests (Additional)
// ============================================================================

describe('Output Utils (Additional)', () => {
  describe('fmt helper', () => {
    it('should have color functions', () => {
      expect(typeof fmt.green).toBe('function');
      expect(typeof fmt.red).toBe('function');
      expect(typeof fmt.yellow).toBe('function');
      expect(typeof fmt.dim).toBe('function');
      expect(typeof fmt.bold).toBe('function');
    });

    it('should return strings', () => {
      expect(typeof fmt.green('test')).toBe('string');
      expect(typeof fmt.red('test')).toBe('string');
      expect(fmt.green('test')).toContain('test');
    });
  });

  describe('formatState (additional states)', () => {
    it('should format QUOTED state', () => {
      const result = formatState('QUOTED');
      expect(result).toContain('QUOTED');
    });

    it('should format COMMITTED state', () => {
      const result = formatState('COMMITTED');
      expect(result).toContain('COMMITTED');
    });

    it('should format IN_PROGRESS state', () => {
      const result = formatState('IN_PROGRESS');
      expect(result).toContain('IN_PROGRESS');
    });

    it('should format DELIVERED state', () => {
      const result = formatState('DELIVERED');
      expect(result).toContain('DELIVERED');
    });

    it('should format DISPUTED state', () => {
      const result = formatState('DISPUTED');
      expect(result).toContain('DISPUTED');
    });
  });
});

// ============================================================================
// Simulate Command Tests (Additional)
// ============================================================================

describe('Simulate Commands (Additional)', () => {
  describe('calculateFee edge cases', () => {
    it('should handle zero amount', () => {
      const result = calculateFee(0n);
      expect(result.fee).toBe(50_000n); // Minimum applies
      expect(result.minimumApplied).toBe(true);
    });

    it('should handle very small amounts', () => {
      // $0.01 USDC = 10000 wei
      const result = calculateFee(10_000n);
      expect(result.fee).toBe(50_000n); // Minimum $0.05
      expect(result.minimumApplied).toBe(true);
      expect(result.effectiveRate).toBe('500.00%'); // $0.05 on $0.01 = 500%
    });

    it('should handle large amounts', () => {
      // $1,000,000 USDC
      const result = calculateFee(1_000_000_000_000n);
      expect(result.fee).toBe(10_000_000_000n); // 1% = $10,000
      expect(result.minimumApplied).toBe(false);
      expect(result.effectiveRate).toBe('1.00%');
    });

    it('should calculate provider receives correctly', () => {
      // $50 -> 1% fee = $0.50, provider gets $49.50
      const result = calculateFee(50_000_000n);
      expect(result.fee).toBe(500_000n);
      expect(result.providerReceives).toBe(49_500_000n);
    });
  });

  describe('SimulationAdapter validation', () => {
    // Import the simulate module to access SimulationAdapter
    const { BaseAdapter } = require('../adapters/BaseAdapter');

    // Create a test subclass to test protected methods
    class TestSimulationAdapter extends BaseAdapter {
      constructor(requesterAddress: string) {
        super(requesterAddress);
      }

      validatePayment(
        to: string,
        amount: string | number,
        deadline?: string | number
      ) {
        const errors: string[] = [];
        const warnings: string[] = [];
        let parsedAmount: bigint | undefined;
        let parsedDeadline: number | undefined;

        try {
          this.validateAddress(to, 'to');
        } catch (e) {
          errors.push((e as Error).message);
        }

        try {
          parsedAmount = this.parseAmount(amount);
          if (parsedAmount !== undefined && parsedAmount < 5_000_000n) {
            warnings.push('Amount is below $5 - minimum fee ($0.05) will apply');
          }
        } catch (e) {
          errors.push((e as Error).message);
        }

        try {
          const currentTime = Math.floor(Date.now() / 1000);
          parsedDeadline = this.parseDeadline(deadline, currentTime);
          if (parsedDeadline !== undefined && parsedDeadline <= currentTime) {
            errors.push('Deadline must be in the future');
          }
        } catch (e) {
          errors.push((e as Error).message);
        }

        if (to.toLowerCase() === this.requesterAddress.toLowerCase()) {
          errors.push('Cannot pay yourself');
        }

        return { valid: errors.length === 0, errors, warnings, parsedAmount, parsedDeadline };
      }
    }

    it('should validate correct payment parameters', () => {
      const adapter = new TestSimulationAdapter('0x1111111111111111111111111111111111111111');
      const result = adapter.validatePayment(
        '0x2222222222222222222222222222222222222222',
        '100',
        '+24h'
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid address', () => {
      const adapter = new TestSimulationAdapter('0x1111111111111111111111111111111111111111');
      const result = adapter.validatePayment('invalid', '100', '+24h');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('address') || e.includes('Address'))).toBe(true);
    });

    it('should reject self-payment', () => {
      const adapter = new TestSimulationAdapter('0x1111111111111111111111111111111111111111');
      const result = adapter.validatePayment(
        '0x1111111111111111111111111111111111111111',
        '100',
        '+24h'
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Cannot pay yourself');
    });

    it('should warn about small amounts', () => {
      const adapter = new TestSimulationAdapter('0x1111111111111111111111111111111111111111');
      const result = adapter.validatePayment(
        '0x2222222222222222222222222222222222222222',
        '1', // $1 < $5
        '+24h'
      );
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w: string) => w.includes('minimum fee'))).toBe(true);
    });
  });
});

// ============================================================================
// Time Command Tests (Additional)
// ============================================================================

describe('Time Commands (Additional)', () => {
  describe('parseDuration edge cases', () => {
    it('should handle zero', () => {
      expect(parseDuration('0')).toBe(0);
      expect(parseDuration('0s')).toBe(0);
    });

    it('should handle large values', () => {
      expect(parseDuration('365d')).toBe(365 * 86400);
      expect(parseDuration('1000h')).toBe(1000 * 3600);
    });

    it('should require lowercase units', () => {
      // parseDuration only accepts lowercase - uppercase throws
      expect(() => parseDuration('1H')).toThrow('Invalid duration format');
      expect(() => parseDuration('1D')).toThrow('Invalid duration format');
      expect(() => parseDuration('1M')).toThrow('Invalid duration format');
      expect(() => parseDuration('1S')).toThrow('Invalid duration format');
    });
  });

  describe('formatDuration edge cases', () => {
    it('should handle zero', () => {
      expect(formatDuration(0)).toBe('0s');
    });

    it('should handle complex durations', () => {
      // 1 day, 2 hours, 3 minutes, 4 seconds = 93784 seconds
      const duration = 1 * 86400 + 2 * 3600 + 3 * 60 + 4;
      const formatted = formatDuration(duration);
      expect(formatted).toContain('1d');
      expect(formatted).toContain('2h');
    });

    it('should omit zero components', () => {
      // Exactly 2 days
      expect(formatDuration(2 * 86400)).toBe('2d');
      // Exactly 3 hours
      expect(formatDuration(3 * 3600)).toBe('3h');
    });
  });
});

// ============================================================================
// Transaction Command Tests
// ============================================================================

describe('Transaction Commands', () => {
  // Helper to format USDC (replicates tx.ts logic for testing)
  function formatUsdc(weiAmount: string): string {
    const amount = BigInt(weiAmount);
    const whole = amount / 1_000_000n;
    const decimal = amount % 1_000_000n;
    const decimalStr = decimal.toString().padStart(6, '0').slice(0, 2);
    return `${whole}.${decimalStr}`;
  }

  describe('formatUsdc helper', () => {
    it('should format whole USDC amounts', () => {
      expect(formatUsdc('10000000')).toBe('10.00'); // 10 USDC
      expect(formatUsdc('100000000')).toBe('100.00'); // 100 USDC
      expect(formatUsdc('1000000')).toBe('1.00'); // 1 USDC
    });

    it('should format fractional USDC amounts', () => {
      expect(formatUsdc('10500000')).toBe('10.50'); // 10.50 USDC
      expect(formatUsdc('1234567')).toBe('1.23'); // 1.234567 USDC (truncated to 2 decimals)
      expect(formatUsdc('500000')).toBe('0.50'); // 0.50 USDC
    });

    it('should handle small amounts', () => {
      expect(formatUsdc('50000')).toBe('0.05'); // $0.05 minimum fee
      expect(formatUsdc('1000')).toBe('0.00'); // Very small (shows 0.00)
      expect(formatUsdc('0')).toBe('0.00'); // Zero
    });

    it('should handle large amounts', () => {
      expect(formatUsdc('1000000000000')).toBe('1000000.00'); // $1M
      expect(formatUsdc('999999999999')).toBe('999999.99'); // Just under $1M
    });
  });

  describe('isValidTxId', () => {
    it('should validate correct transaction IDs', () => {
      // 66 chars: 0x + 64 hex chars
      const validTxId = '0x' + 'a'.repeat(64);
      expect(isValidTxId(validTxId)).toBe(true);
    });

    it('should validate with mixed case hex', () => {
      const txId = '0x' + 'aAbBcCdDeEfF'.repeat(5) + 'aaaa';
      expect(isValidTxId(txId)).toBe(true);
    });

    it('should reject invalid transaction IDs', () => {
      expect(isValidTxId('invalid')).toBe(false);
      expect(isValidTxId('0x123')).toBe(false); // Too short
      expect(isValidTxId('0x' + 'g'.repeat(64))).toBe(false); // Invalid hex
      expect(isValidTxId('')).toBe(false);
      expect(isValidTxId('0x' + 'a'.repeat(63))).toBe(false); // 65 chars (1 short)
      expect(isValidTxId('0x' + 'a'.repeat(65))).toBe(false); // 67 chars (1 extra)
    });

    it('should require 0x prefix', () => {
      const noPrefixTxId = 'a'.repeat(64);
      expect(isValidTxId(noPrefixTxId)).toBe(false);
    });
  });

  describe('Transaction state validation', () => {
    const validStates = [
      'INITIATED',
      'QUOTED',
      'COMMITTED',
      'IN_PROGRESS',
      'DELIVERED',
      'SETTLED',
      'DISPUTED',
      'CANCELLED',
    ];

    it('should recognize all valid states', () => {
      validStates.forEach(state => {
        const formatted = formatState(state as any);
        expect(formatted).toContain(state);
      });
    });
  });

  describe('Transaction deadline parsing', () => {
    it('should parse relative deadlines', () => {
      // These are parsed in tx.ts using parseDuration or direct regex
      expect(parseDuration('24h')).toBe(86400);
      expect(parseDuration('7d')).toBe(604800);
      expect(parseDuration('1h')).toBe(3600);
    });

    it('should handle numeric deadlines as Unix timestamps', () => {
      // In tx.ts, numeric strings are parsed as integers
      const numericDeadline = '1735084800'; // Some future timestamp
      expect(parseInt(numericDeadline, 10)).toBe(1735084800);
    });
  });
});

// ============================================================================
// CLI Version Tests
// ============================================================================

describe('CLI Version', () => {
  it('should read version from package.json', () => {
    const packageJson = require('../../package.json');
    expect(typeof packageJson.version).toBe('string');
    expect(packageJson.version.length).toBeGreaterThan(0);
  });

  it('should have version in correct semver format', () => {
    const packageJson = require('../../package.json');
    const semverPattern = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
    expect(packageJson.version).toMatch(semverPattern);
  });
});

// ============================================================================
// CLI Command Structure Tests
// ============================================================================

describe('CLI Command Structure', () => {
  it('should export all required commands', () => {
    const { createInitCommand } = require('./commands/init');
    const { createPayCommand } = require('./commands/pay');
    const { createTxCommand } = require('./commands/tx');
    const { createBalanceCommand } = require('./commands/balance');
    const { createMintCommand } = require('./commands/mint');
    const { createConfigCommand } = require('./commands/config');
    const { createWatchCommand } = require('./commands/watch');
    const { createSimulateCommand } = require('./commands/simulate');
    const { createBatchCommand } = require('./commands/batch');
    const { createTimeCommand } = require('./commands/time');

    // All command creators should be functions
    expect(typeof createInitCommand).toBe('function');
    expect(typeof createPayCommand).toBe('function');
    expect(typeof createTxCommand).toBe('function');
    expect(typeof createBalanceCommand).toBe('function');
    expect(typeof createMintCommand).toBe('function');
    expect(typeof createConfigCommand).toBe('function');
    expect(typeof createWatchCommand).toBe('function');
    expect(typeof createSimulateCommand).toBe('function');
    expect(typeof createBatchCommand).toBe('function');
    expect(typeof createTimeCommand).toBe('function');
  });

  it('should create tx command with all subcommands', () => {
    const { createTxCommand } = require('./commands/tx');
    const txCmd = createTxCommand();

    // Check that tx command has the expected subcommands
    const subcommandNames = txCmd.commands.map((cmd: any) => cmd.name());
    expect(subcommandNames).toContain('create');
    expect(subcommandNames).toContain('status');
    expect(subcommandNames).toContain('list');
    expect(subcommandNames).toContain('deliver');
    expect(subcommandNames).toContain('settle');
    expect(subcommandNames).toContain('cancel');
    expect(subcommandNames).toHaveLength(6);
  });

  it('should create config command with all subcommands', () => {
    const { createConfigCommand } = require('./commands/config');
    const configCmd = createConfigCommand();

    const subcommandNames = configCmd.commands.map((cmd: any) => cmd.name());
    expect(subcommandNames).toContain('show');
    expect(subcommandNames).toContain('set');
  });
});

// ============================================================================
// AIP-12: Auto-mode Address Config Tests (ISSUE-005)
// ============================================================================

describe('AIP-12: Auto-mode Config', () => {
  describe('smartWallet and registered fields', () => {
    it('should persist smartWallet field in config', () => {
      const config: CLIConfig = {
        mode: 'testnet',
        address: '0x1111111111111111111111111111111111111111',
        version: '1.0',
        smartWallet: '0x2222222222222222222222222222222222222222',
        registered: true,
      };

      saveConfig(config, testDir);
      const loaded = loadConfig(testDir);

      expect(loaded.smartWallet).toBe('0x2222222222222222222222222222222222222222');
      expect(loaded.registered).toBe(true);
    });

    it('should handle config without smartWallet (backward compat)', () => {
      const config: CLIConfig = {
        mode: 'mock',
        address: '0x1111111111111111111111111111111111111111',
        version: '1.0',
      };

      saveConfig(config, testDir);
      const loaded = loadConfig(testDir);

      expect(loaded.smartWallet).toBeUndefined();
      expect(loaded.registered).toBeUndefined();
    });

    it('should store EOA as address when not registered', () => {
      const eoaAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const smartWalletAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      const config: CLIConfig = {
        mode: 'testnet',
        address: eoaAddress, // EOA when not registered
        version: '1.0',
        smartWallet: smartWalletAddress,
        registered: false,
      };

      saveConfig(config, testDir);
      const loaded = loadConfig(testDir);

      // address should be EOA (not Smart Wallet)
      expect(loaded.address).toBe(eoaAddress);
      // smartWallet is still available for later registration
      expect(loaded.smartWallet).toBe(smartWalletAddress);
      expect(loaded.registered).toBe(false);
    });

    it('should store Smart Wallet as address when registered', () => {
      const smartWalletAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      const config: CLIConfig = {
        mode: 'testnet',
        address: smartWalletAddress, // Smart Wallet when registered
        version: '1.0',
        smartWallet: smartWalletAddress,
        registered: true,
      };

      saveConfig(config, testDir);
      const loaded = loadConfig(testDir);

      expect(loaded.address).toBe(smartWalletAddress);
      expect(loaded.registered).toBe(true);
    });
  });
});
