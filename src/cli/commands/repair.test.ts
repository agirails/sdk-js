/**
 * Unit tests for `actp repair`.
 *
 * The command's job is to send the right on-chain methods (or refuse
 * with the right error). We mock AgentRegistry / AgentRegistryClient so
 * the test is hermetic — no RPC, no signer.
 *
 * Coverage:
 *  - input validation (boolean parsing, https-only endpoint, no-action error)
 *  - non-TTY without --yes is a hard fail
 *  - --yes bypasses prompt
 *  - keccak256 hash matches contract's serviceTypeHash for removeServiceType
 */

import { describe, it, expect, jest } from '@jest/globals';
import { ethers } from 'ethers';

let nextAnswer = '';
jest.mock('readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (a: string) => void) => cb(nextAnswer),
    close: () => {},
  }),
}));

const mockRemoveServiceType = jest.fn(async (_h: string) => '0xremove');
const mockUpdateEndpoint = jest.fn(async (_url: string) => '0xendpoint');
const mockSetActiveStatus = jest.fn(async (_b: boolean) => '0xactive');
const mockSetListed = jest.fn(async (_b: boolean) => '0xlisted');

jest.mock('../../protocol/AgentRegistry', () => ({
  AgentRegistry: jest.fn().mockImplementation(() => ({
    removeServiceType: mockRemoveServiceType,
    updateEndpoint: mockUpdateEndpoint,
    setActiveStatus: mockSetActiveStatus,
  })),
}));

jest.mock('../../registry/AgentRegistryClient', () => ({
  AgentRegistryClient: jest.fn().mockImplementation(() => ({
    setListed: mockSetListed,
  })),
}));

jest.mock('../../wallet/keystore', () => ({
  resolvePrivateKey: jest.fn(async () => '0x' + '11'.repeat(32)),
}));

jest.mock('../utils/config', () => ({
  loadConfig: () => ({ address: '0x' + 'a'.repeat(40), mode: 'testnet' }),
}));

import { Output } from '../utils/output';

// Import last, after mocks are set up
let createRepairCommand: typeof import('./repair').createRepairCommand;
beforeAll(async () => {
  ({ createRepairCommand } = await import('./repair'));
});

beforeEach(() => {
  jest.clearAllMocks();
  nextAnswer = '';
});

async function runCmd(argv: string[]): Promise<{ exitCode: number; calls: typeof mockRemoveServiceType.mock.calls }> {
  const cmd = createRepairCommand();
  cmd.exitOverride();
  let exitCode = 0;
  try {
    await cmd.parseAsync(['node', 'actp', ...argv]);
  } catch (e) {
    exitCode = (e as { exitCode?: number }).exitCode ?? 1;
  }
  return { exitCode, calls: mockRemoveServiceType.mock.calls };
}

describe('actp repair', () => {
  it('hard-fails when no action flags are passed', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await runCmd(['--yes']);
    expect(exitSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects non-https endpoint', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await runCmd(['--endpoint', 'http://example.com', '--yes']);
    expect(exitSpy).toHaveBeenCalled();
    expect(mockUpdateEndpoint).not.toHaveBeenCalled();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('non-TTY without --yes is rejected', async () => {
    const orig = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await runCmd(['--remove-service', 'code-review']);
    expect(exitSpy).toHaveBeenCalled();
    expect(mockRemoveServiceType).not.toHaveBeenCalled();
    (process.stdin as { isTTY?: boolean }).isTTY = orig;
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('removeService hashes the name with keccak256(toUtf8Bytes)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await runCmd(['--remove-service', 'code-review', '--yes']);
    expect(mockRemoveServiceType).toHaveBeenCalledTimes(1);
    const expectedHash = ethers.keccak256(ethers.toUtf8Bytes('code-review'));
    expect(mockRemoveServiceType.mock.calls[0][0]).toBe(expectedHash);
    logSpy.mockRestore();
  });

  it('runs all four actions in one invocation when flags are combined', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await runCmd([
      '--remove-service', 'translation',
      '--endpoint', 'https://my-agent.example.com/api',
      '--active', 'false',
      '--listed', 'true',
      '--yes',
    ]);
    expect(mockRemoveServiceType).toHaveBeenCalledTimes(1);
    expect(mockUpdateEndpoint).toHaveBeenCalledWith('https://my-agent.example.com/api');
    expect(mockSetActiveStatus).toHaveBeenCalledWith(false);
    expect(mockSetListed).toHaveBeenCalledWith(true);
    logSpy.mockRestore();
  });

  it('TTY prompt accepts "y"', async () => {
    const orig = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    nextAnswer = 'y';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await runCmd(['--remove-service', 'code-review']);
    expect(mockRemoveServiceType).toHaveBeenCalledTimes(1);
    (process.stdin as { isTTY?: boolean }).isTTY = orig;
    logSpy.mockRestore();
  });

  it('TTY prompt declined ("n") sends nothing on-chain', async () => {
    const orig = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    nextAnswer = 'n';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await runCmd(['--remove-service', 'code-review']);
    expect(mockRemoveServiceType).not.toHaveBeenCalled();
    (process.stdin as { isTTY?: boolean }).isTTY = orig;
    logSpy.mockRestore();
  });

  it('parses boolean flags case-insensitively', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await runCmd(['--active', 'TRUE', '--yes']);
    expect(mockSetActiveStatus).toHaveBeenCalledWith(true);
    logSpy.mockRestore();
  });

  it('rejects garbage boolean values', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await runCmd(['--active', 'maybe', '--yes']);
    expect(exitSpy).toHaveBeenCalled();
    expect(mockSetActiveStatus).not.toHaveBeenCalled();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
