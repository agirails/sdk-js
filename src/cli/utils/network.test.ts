/**
 * Unified network resolution tests (F-2 fix).
 *
 * Covers the precedence ladder (flag > ACTP_NETWORK > config.mode > testnet)
 * and the hybrid real-money guard: a flag/env may freely downgrade to
 * testnet/mock, but can NEVER escalate to mainnet over a non-mainnet config.
 *
 * @module cli/utils/network.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { saveConfig, type CLIMode } from './config';
import { resolveNetwork, parseCliNetwork, describeNetwork } from './network';

describe('network resolution (F-2)', () => {
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'network-test-'));
    savedEnv = process.env.ACTP_NETWORK;
    delete process.env.ACTP_NETWORK;
  });

  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.ACTP_NETWORK;
    else process.env.ACTP_NETWORK = savedEnv;
  });

  function writeConfig(mode: CLIMode): void {
    saveConfig({ mode, address: '0x' + '1'.repeat(40), version: '1.0' }, dir);
  }

  // --------------------------------------------------------------------------
  // parseCliNetwork
  // --------------------------------------------------------------------------
  describe('parseCliNetwork', () => {
    test('accepts mock | testnet | mainnet, case-insensitive + trimmed', () => {
      expect(parseCliNetwork('mock', '--network')).toBe('mock');
      expect(parseCliNetwork('TESTNET', '--network')).toBe('testnet');
      expect(parseCliNetwork('  Mainnet ', 'ACTP_NETWORK')).toBe('mainnet');
    });

    test('throws on invalid value, naming the origin', () => {
      expect(() => parseCliNetwork('base-sepolia', '--network')).toThrow(/--network/);
      expect(() => parseCliNetwork('prod', 'ACTP_NETWORK')).toThrow(/ACTP_NETWORK/);
    });
  });

  // --------------------------------------------------------------------------
  // Precedence: flag > env > config > default
  // --------------------------------------------------------------------------
  describe('precedence', () => {
    test('flag wins over env and config', () => {
      writeConfig('mainnet');
      process.env.ACTP_NETWORK = 'mock';
      expect(resolveNetwork('testnet', dir)).toEqual({ network: 'testnet', source: 'flag' });
    });

    test('env wins over config when no flag', () => {
      writeConfig('mainnet');
      process.env.ACTP_NETWORK = 'testnet';
      expect(resolveNetwork(undefined, dir)).toEqual({ network: 'testnet', source: 'env' });
    });

    test('config used when no flag and no env', () => {
      writeConfig('testnet');
      expect(resolveNetwork(undefined, dir)).toEqual({ network: 'testnet', source: 'config' });
    });

    test('defaults to testnet when nothing is set (no config, no flag, no env)', () => {
      expect(resolveNetwork(undefined, dir)).toEqual({ network: 'testnet', source: 'default' });
    });

    test('empty-string flag is treated as absent', () => {
      writeConfig('mock');
      expect(resolveNetwork('', dir)).toEqual({ network: 'mock', source: 'config' });
    });
  });

  // --------------------------------------------------------------------------
  // Hybrid guard: downgrade freely, never escalate to mainnet
  // --------------------------------------------------------------------------
  describe('mainnet guard', () => {
    test('flag may downgrade mainnet config to testnet', () => {
      writeConfig('mainnet');
      expect(resolveNetwork('testnet', dir)).toEqual({ network: 'testnet', source: 'flag' });
    });

    test('env may downgrade mainnet config to mock', () => {
      writeConfig('mainnet');
      process.env.ACTP_NETWORK = 'mock';
      expect(resolveNetwork(undefined, dir)).toEqual({ network: 'mock', source: 'env' });
    });

    test('flag mainnet over testnet config is REFUSED', () => {
      writeConfig('testnet');
      expect(() => resolveNetwork('mainnet', dir)).toThrow(/Refusing to run on mainnet/);
    });

    test('env mainnet over testnet config is REFUSED', () => {
      writeConfig('testnet');
      process.env.ACTP_NETWORK = 'mainnet';
      expect(() => resolveNetwork(undefined, dir)).toThrow(/ACTP_NETWORK=mainnet/);
    });

    test('flag mainnet with no config is REFUSED (cannot escalate without config mainnet)', () => {
      expect(() => resolveNetwork('mainnet', dir)).toThrow(/Refusing to run on mainnet/);
    });

    test('config mainnet with no flag/env resolves to mainnet', () => {
      writeConfig('mainnet');
      expect(resolveNetwork(undefined, dir)).toEqual({ network: 'mainnet', source: 'config' });
    });

    test('flag mainnet with config mainnet is allowed', () => {
      writeConfig('mainnet');
      expect(resolveNetwork('mainnet', dir)).toEqual({ network: 'mainnet', source: 'flag' });
    });
  });

  // --------------------------------------------------------------------------
  // describeNetwork
  // --------------------------------------------------------------------------
  describe('describeNetwork', () => {
    test('formats network + human-readable source', () => {
      expect(describeNetwork({ network: 'testnet', source: 'flag' })).toBe('testnet (from --network)');
      expect(describeNetwork({ network: 'mock', source: 'env' })).toBe('mock (from ACTP_NETWORK)');
      expect(describeNetwork({ network: 'mainnet', source: 'config' })).toBe('mainnet (from config mode)');
      expect(describeNetwork({ network: 'testnet', source: 'default' })).toBe('testnet (default)');
    });
  });
});
