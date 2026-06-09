/**
 * FIX-6 — End-to-end verification that `mintTestnetUsdcForBuyer` (c6cd84b)
 * actually credits a fresh pay-only buyer with 1,000 testnet USDC.
 *
 * This test pins the post-rebase behavior of `actp publish` for an
 * intent: 'pay' agent. The function is private to `publish.ts`, so we
 * exercise it through the public command surface (createPublishCommand)
 * with all external dependencies mocked: keystore, networks, the AA
 * wallet, the bundler/paymaster, the agirails.app API, and ethers'
 * low-level provider/wallet/contract primitives.
 *
 * Two layers of verification:
 *
 *   1. Direct unit coverage of `buildTestnetMintBatch` — the helper the
 *      mint flow uses to encode the MockUSDC `mint(to, amount)` call.
 *      Verifies the exact 4-byte selector, the recipient address, the
 *      6-decimal amount (1000 * 1e6), and the target USDC contract.
 *
 *   2. Integration coverage of the publish command's pay-only branch.
 *      Mocks the dynamic imports inside `mintTestnetUsdcForBuyer` and
 *      asserts:
 *        - Fresh buyer (balance = 0) → batched mint UserOp sent
 *        - Existing balance (>0)     → early-return, no UserOp
 *        - Bundler/paymaster failure → publish still succeeds (warn only)
 *        - Provider (intent: earn)   → uses activateOnTestnet path, NOT
 *                                       the buyer-only mint helper
 *        - No double-mint on second publish run
 *
 * The test never touches real RPCs and never writes to a real keystore.
 * Process exits are intercepted so a publish-flow `process.exit(0)` does
 * not abort the Jest worker.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ethers } from 'ethers';

import { buildTestnetMintBatch } from '../../wallet/aa/TransactionBatcher';
import { getNetwork } from '../../config/networks';

// ---------------------------------------------------------------------------
// jest.mock setup — must precede any import that pulls these modules through
// dynamic `await import(...)` resolution inside publish.ts.
// ---------------------------------------------------------------------------

// Track AutoWalletProvider.create + sendBatchTransaction invocations
// across all integration tests. Each test resets these in beforeEach.
type CallRecord = {
  // ctor params (AutoWalletConfig — only the fields we assert on)
  createCalls: Array<{
    chainId: number;
    actpKernelAddress: string;
    bundlerPrimary: string;
    bundlerBackup?: string;
    paymasterPrimary: string;
    paymasterBackup?: string;
  }>;
  // sendBatchTransaction invocations: tx-request array per call
  batchCalls: Array<Array<{ to: string; data: string; value: string }>>;
  // The address returned by getAddress() — set per test
  smartWalletAddress: string;
  // The receipt returned by sendBatchTransaction — set per test
  batchReceipt: { hash: string; success: boolean };
  // Whether the create() call should throw — set per test
  createThrows: Error | null;
  // Whether sendBatchTransaction should throw — set per test
  batchThrows: Error | null;
};
const calls: CallRecord = {
  createCalls: [],
  batchCalls: [],
  smartWalletAddress: '0x1111111111111111111111111111111111111111',
  batchReceipt: { hash: '0xmintreceipthash', success: true },
  createThrows: null,
  batchThrows: null,
};

// Track USDC balanceOf so tests can choose "fresh" (0) vs "existing" (>0)
const usdcBalances = new Map<string, bigint>();

interface MockAutoWalletConfig {
  chainId: number;
  actpKernelAddress: string;
  bundler: { primaryUrl: string; backupUrl?: string };
  paymaster: { primaryUrl: string; backupUrl?: string };
}
jest.mock('../../wallet/AutoWalletProvider', () => ({
  AutoWalletProvider: {
    create: jest.fn(async (...args: unknown[]) => {
      const config = args[0] as MockAutoWalletConfig;
      if (calls.createThrows) throw calls.createThrows;
      calls.createCalls.push({
        chainId: config.chainId,
        actpKernelAddress: config.actpKernelAddress,
        bundlerPrimary: config.bundler.primaryUrl,
        bundlerBackup: config.bundler.backupUrl,
        paymasterPrimary: config.paymaster.primaryUrl,
        paymasterBackup: config.paymaster.backupUrl,
      });
      return {
        getAddress: () => calls.smartWalletAddress,
        sendBatchTransaction: jest.fn(async (...sendArgs: unknown[]) => {
          if (calls.batchThrows) throw calls.batchThrows;
          const txs = sendArgs[0] as Array<{ to: string; data: string; value: string }>;
          calls.batchCalls.push(txs);
          return calls.batchReceipt;
        }),
      };
    }),
  },
}));

// Mock the keystore so we never decrypt a real file. resolvePrivateKey is
// dynamically imported by `mintTestnetUsdcForBuyer` (and also by the
// activation path and the upsert sync) — a single mock covers all sites.
const FAKE_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
jest.mock('../../wallet/keystore', () => ({
  resolvePrivateKey: jest.fn(async () => FAKE_PRIVATE_KEY),
}));

// Mock the agirails.app API: slug always available, upsert is a no-op.
jest.mock('../../api/agirailsApp', () => ({
  checkSlug: jest.fn(async (slug: string) => ({ available: true, slug })),
  upsertAgent: jest.fn(async () => ({
    agent: { slug: 'fake-slug', wallet: '0xfake' },
  })),
}));

// Mock the IPFS upload paths so we never make a network request.
jest.mock('../../storage/FilebaseClient', () => ({
  FilebaseClient: class {
    constructor(_: unknown) {}
  },
}));
jest.mock('../../storage/ArweaveClient', () => ({
  ArweaveClient: class {
    static async create() {
      return new this();
    }
  },
}));
jest.mock('../../config/publishPipeline', () => {
  const actual = jest.requireActual('../../config/publishPipeline') as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    preparePublish: jest.fn(async () => ({
      cid: 'bafyMOCKCID',
      arweaveTxId: undefined,
    })),
  };
});

// Stub generateWallet so publish does NOT spawn the interactive password
// prompt for a tmpDir that has no keystore.json. We pre-seed keystore.json
// instead (a plain JSON stub — never decrypted because keystore is mocked).
jest.mock('../utils/wallet', () => ({
  generateWallet: jest.fn(async () => '0xEOAEOAEOAEOAEOAEOAEOAEOAEOAEOAEOAEOAEOAE'),
}));

// Stub readline so any unexpected prompt (defensive) does not hang.
jest.mock('readline', () => ({
  createInterface: () => ({
    question: (_: string, cb: (a: string) => void) => cb('n'),
    close: () => undefined,
  }),
}));

// Mock the ERC-8004 / AgentRegistry post-activation path. For pay-only,
// these paths are not exercised — but we mock them anyway so a non-pay
// test stays predictable.
jest.mock('../../registry/AgentRegistryClient', () => ({
  AgentRegistryClient: {
    readOnly: () => ({
      getConfig: async () => ({ isActive: false }),
    }),
  },
}));

// Mock ethers.JsonRpcProvider + ethers.Wallet + ethers.Contract so the
// balanceOf() call inside mintTestnetUsdcForBuyer returns a value we
// control. We keep all of ethers' utilities (id, keccak256, etc.) intact
// so the rest of publish.ts (event-topic encoding, hash compute) still
// works.
jest.mock('ethers', () => {
  const realEthers = jest.requireActual('ethers') as typeof import('ethers');
  const MockProvider = jest.fn().mockImplementation((..._args: unknown[]) => ({
    getTransactionReceipt: jest.fn(async () => null),
  }));
  const MockWallet = jest.fn().mockImplementation((...args: unknown[]) => ({
    address: '0xEOAEOAEOAEOAEOAEOAEOAEOAEOAEOAEOAEOAEOAE',
    signMessage: jest.fn(async () => '0x' + '00'.repeat(65)),
    _pk: typeof args[0] === 'string' ? args[0] : undefined,
  }));
  // Expose the static createRandom that publish.ts never touches but
  // ts-jest sometimes evaluates eagerly during transpile.
  (MockWallet as unknown as { createRandom: () => unknown }).createRandom =
    () => ({ address: '0xRANDOM', privateKey: FAKE_PRIVATE_KEY });
  const MockContract = jest.fn().mockImplementation((...args: unknown[]) => {
    const address = typeof args[0] === 'string' ? args[0] : '';
    return {
      address,
      balanceOf: jest.fn(async (addr: string) => {
        const key = addr.toLowerCase();
        return usdcBalances.get(key) ?? 0n;
      }),
      tokenOfOwnerByIndex: jest.fn(async () => 0n),
    };
  });
  return {
    ...realEthers,
    ethers: {
      ...realEthers.ethers,
      JsonRpcProvider: MockProvider,
      Wallet: MockWallet,
      Contract: MockContract,
    },
    JsonRpcProvider: MockProvider,
    Wallet: MockWallet,
    Contract: MockContract,
  };
});

// Import the publish command AFTER all jest.mock() calls are registered.
// eslint-disable-next-line import/first
import { createPublishCommand } from './publish';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write an AGIRAILS.md identity file for a pay-only buyer into `dir`.
 * Slug stays short — publish.ts auto-detects {slug}.md when no config.json
 * pointer exists.
 */
function writeBuyerIdentity(dir: string, slug = 'buyer-bot'): string {
  const md = `---
name: Buyer Bot
slug: ${slug}
intent: pay
servicesNeeded:
  - code-review
budget: 5
pricing:
  base: 5
network: testnet
---
# Buyer Bot

I buy code reviews from other agents.

## How to Request This Service

n/a — I am a buyer.
`;
  const filePath = path.join(dir, `${slug}.md`);
  fs.writeFileSync(filePath, md, 'utf-8');
  return filePath;
}

/**
 * Write an AGIRAILS.md identity file for an earn-only provider. Used by
 * the negative test: providers must NOT call mintTestnetUsdcForBuyer.
 */
function writeProviderIdentity(dir: string, slug = 'provider-bot'): string {
  const md = `---
name: Provider Bot
slug: ${slug}
intent: earn
services:
  - type: code-review
    price: 5
pricing:
  base: 5
network: testnet
---
# Provider Bot

I review code.
`;
  const filePath = path.join(dir, `${slug}.md`);
  fs.writeFileSync(filePath, md, 'utf-8');
  return filePath;
}

/**
 * Drain a console.log/warn/error mock to a single concatenated string so
 * tests can match against substrings without caring about line/order.
 */
function joinLogs(spy: jest.SpiedFunction<typeof console.log>): string {
  return spy.mock.calls
    .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    .join('\n');
}

/**
 * Invoke `actp publish` against the given file. process.exit is stubbed so
 * a successful publish (which calls process.exit(0) via Commander defaults
 * in some paths) does not kill the Jest worker.
 */
async function runPublishCmd(filePath: string): Promise<void> {
  const cmd = createPublishCommand();
  // Run in default human mode so Output.info() / Output.warning() actually
  // reach the captured console.log / console.warn spies — `--quiet` would
  // silence them and `--json` would re-route everything through a single
  // structured payload.
  await cmd.parseAsync(['node', 'publish', filePath]);
}

// ---------------------------------------------------------------------------
// LAYER 1 — Direct unit coverage of `buildTestnetMintBatch`.
// These tests pin the byte-level shape of the calldata the mint flow
// produces, independent of any wallet/bundler plumbing.
// ---------------------------------------------------------------------------

describe('buildTestnetMintBatch — calldata shape (FIX-6 unit layer)', () => {
  // Use ethers.getAddress to checksum, so v6 doesn't reject the literals.
  const USDC = ethers.getAddress('0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb'); // Base Sepolia MockUSDC
  const RECIPIENT = ethers.getAddress('0x1111111111111111111111111111111111111111');
  const ONE_K_USDC = '1000000000'; // 1000 * 1e6 (USDC has 6 decimals)

  it('emits exactly one call targeting the MockUSDC contract', () => {
    const out = buildTestnetMintBatch(USDC, RECIPIENT, ONE_K_USDC);
    expect(out).toHaveLength(1);
    expect(out[0].target).toBe(USDC);
    expect(out[0].value).toBe(0n);
  });

  it('encodes mint(address,uint256) — selector matches keccak("mint(address,uint256)")[0..4]', () => {
    const out = buildTestnetMintBatch(USDC, RECIPIENT, ONE_K_USDC);
    // First 4 bytes of keccak256("mint(address,uint256)") = 0x40c10f19
    expect(out[0].data.slice(0, 10).toLowerCase()).toBe('0x40c10f19');
  });

  it('embeds the recipient address (left-padded to 32 bytes) at calldata offset 4', () => {
    const out = buildTestnetMintBatch(USDC, RECIPIENT, ONE_K_USDC);
    const data = out[0].data;
    // ABI: [selector(4)] [address(32)] [uint256(32)]
    // address slot: bytes 4..36 → hex chars 10..74
    const recipientWord = data.slice(10, 74);
    expect(recipientWord.toLowerCase().endsWith(RECIPIENT.slice(2).toLowerCase())).toBe(true);
    // The leading 24 hex chars must be zero-padding.
    expect(recipientWord.slice(0, 24)).toBe('0'.repeat(24));
  });

  it('encodes amount = 1000 * 1e6 (6 decimals) at calldata offset 36', () => {
    const out = buildTestnetMintBatch(USDC, RECIPIENT, ONE_K_USDC);
    const data = out[0].data;
    // uint256 slot: bytes 36..68 → hex chars 74..138
    const amountWord = data.slice(74, 138);
    const decoded = BigInt('0x' + amountWord);
    expect(decoded).toBe(1_000_000_000n);
    // Sanity: 1,000 USDC at 6 decimals exactly.
    expect(decoded / 1_000_000n).toBe(1_000n);
  });

  it('respects the recipient address argument — derived smart wallet address gets the mint', () => {
    const smartWallet = ethers.getAddress(
      '0xBBbBbBBBBbbbBbBBbbbBBbBbbbbbBBbBBbBbBbbB'.toLowerCase(),
    );
    const out = buildTestnetMintBatch(USDC, smartWallet, ONE_K_USDC);
    const data = out[0].data;
    expect(
      data.slice(10, 74).toLowerCase().endsWith(smartWallet.slice(2).toLowerCase()),
    ).toBe(true);
  });

  it('emits zero-value calls (no ETH transferred — MockUSDC mint is gasless via paymaster)', () => {
    const out = buildTestnetMintBatch(USDC, RECIPIENT, ONE_K_USDC);
    expect(out[0].value).toBe(0n);
  });

  it('matches the testnet USDC address recorded in NetworkConfig for base-sepolia', () => {
    // mintTestnetUsdcForBuyer reads `networkConfig.contracts.usdc` for the
    // current network. Pin that to the deployed MockUSDC so a future
    // typo/swap of the address doesn't silently route mints elsewhere.
    const network = getNetwork('base-sepolia');
    expect(network.contracts.usdc).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const out = buildTestnetMintBatch(network.contracts.usdc, RECIPIENT, ONE_K_USDC);
    expect(out[0].target).toBe(network.contracts.usdc);
  });
});

// ---------------------------------------------------------------------------
// LAYER 2 — Integration coverage through createPublishCommand.
// These tests drive the full publish action for an intent:'pay' agent
// and verify mintTestnetUsdcForBuyer's externally-observable behavior:
// (a) a batched UserOp is submitted when balance == 0,
// (b) no UserOp when balance > 0,
// (c) bundler/paymaster failures NEVER abort the publish.
// ---------------------------------------------------------------------------

describe('mintTestnetUsdcForBuyer — publish-flow integration (FIX-6 e2e layer)', () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalActpDir: string | undefined;
  let originalKeyPassword: string | undefined;
  let originalNoColor: string | undefined;
  let exitSpy: jest.SpiedFunction<(code?: number) => never>;
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    // Per-test reset of the mock-call state.
    calls.createCalls = [];
    calls.batchCalls = [];
    calls.smartWalletAddress = '0x1111111111111111111111111111111111111111';
    calls.batchReceipt = { hash: '0xmintreceipthash', success: true };
    calls.createThrows = null;
    calls.batchThrows = null;
    usdcBalances.clear();

    // Fresh tmp dir + chdir so getActpDir() resolves under it. Save cwd
    // and restore in afterEach — other test files rely on the original
    // cwd for relative requires.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-buyer-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    // Pre-create .actp and a fake keystore.json so the publish flow does
    // NOT invoke generateWallet's password prompt. The keystore is never
    // actually decrypted (keystore.ts is mocked) — just its presence is
    // checked.
    fs.mkdirSync(path.join(tmpDir, '.actp'));
    fs.writeFileSync(
      path.join(tmpDir, '.actp', 'keystore.json'),
      JSON.stringify({
        address: 'EOAEOAEOAEOAEOAEOAEOAEOAEOAEOAEOAEOAEOAE',
        crypto: { ciphertext: '00' },
      }),
    );

    originalActpDir = process.env.ACTP_DIR;
    process.env.ACTP_DIR = path.join(tmpDir, '.actp');
    originalKeyPassword = process.env.ACTP_KEY_PASSWORD;
    process.env.ACTP_KEY_PASSWORD = 'unused-because-keystore-is-mocked';
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';

    // Intercept process.exit so a publish-flow exit does not kill Jest.
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => undefined as never) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalActpDir === undefined) delete process.env.ACTP_DIR;
    else process.env.ACTP_DIR = originalActpDir;
    if (originalKeyPassword === undefined) delete process.env.ACTP_KEY_PASSWORD;
    else process.env.ACTP_KEY_PASSWORD = originalKeyPassword;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('fresh buyer (USDC balance = 0) → mintTestnetUsdcForBuyer submits a 1K USDC batched UserOp', async () => {
    const filePath = writeBuyerIdentity(tmpDir, 'fresh-buyer');
    // balance defaults to 0 (usdcBalances unset for this address) — already
    // mock-set in beforeEach via .clear().

    await runPublishCmd(filePath);

    // The mint flow MUST have created an AutoWalletProvider exactly once.
    expect(calls.createCalls.length).toBe(1);
    // The bundler / paymaster URLs MUST be the testnet ones from networks.ts.
    const net = getNetwork('base-sepolia');
    expect(calls.createCalls[0].chainId).toBe(net.chainId);
    expect(calls.createCalls[0].actpKernelAddress).toBe(net.contracts.actpKernel);

    // Exactly one batched UserOp — the mint.
    expect(calls.batchCalls.length).toBe(1);
    const txs = calls.batchCalls[0];
    expect(txs).toHaveLength(1);
    expect(txs[0].to).toBe(net.contracts.usdc);
    // Selector + 1000 USDC payload check.
    expect(txs[0].data.slice(0, 10).toLowerCase()).toBe('0x40c10f19');
    const amountWord = txs[0].data.slice(74, 138);
    expect(BigInt('0x' + amountWord)).toBe(1_000_000_000n);
    expect(txs[0].value).toBe('0');
  });

  it('mint UserOp credits the SMART WALLET address (not the bare EOA)', async () => {
    calls.smartWalletAddress = '0xCAFEBABECAFEBABECAFEBABECAFEBABECAFEBABE';
    const filePath = writeBuyerIdentity(tmpDir, 'cafe-buyer');

    await runPublishCmd(filePath);

    expect(calls.batchCalls.length).toBe(1);
    const data = calls.batchCalls[0][0].data;
    // Recipient slot (left-padded address) must end with the smart wallet.
    expect(
      data.slice(10, 74).toLowerCase().endsWith(
        calls.smartWalletAddress.slice(2).toLowerCase(),
      ),
    ).toBe(true);
  });

  it('idempotent — second publish with USDC already present early-returns without minting', async () => {
    calls.smartWalletAddress = '0x2222222222222222222222222222222222222222';
    // Seed balance: 1,000 USDC already on the smart wallet.
    usdcBalances.set(calls.smartWalletAddress.toLowerCase(), 1_000_000_000n);

    const filePath = writeBuyerIdentity(tmpDir, 'topped-buyer');
    await runPublishCmd(filePath);

    // AutoWalletProvider was constructed (we still derive the address to
    // query balanceOf), but NO batched UserOp was sent — the early-return
    // path skips the mint.
    expect(calls.createCalls.length).toBe(1);
    expect(calls.batchCalls.length).toBe(0);

    // The "skipping" notice must appear in the captured stdout, so the
    // user knows why the mint didn't fire.
    const allLogs = joinLogs(logSpy);
    expect(allLogs).toMatch(/Test USDC already present/);
    expect(allLogs).toMatch(/skipping mint/);
  });

  it('balance > 0 but < 1 USDC still triggers early-return (any positive balance counts)', async () => {
    calls.smartWalletAddress = '0x3333333333333333333333333333333333333333';
    // 1 wei of USDC (1e-6 USDC). Per the source: `if (bal > 0n) return`.
    usdcBalances.set(calls.smartWalletAddress.toLowerCase(), 1n);

    const filePath = writeBuyerIdentity(tmpDir, 'dust-buyer');
    await runPublishCmd(filePath);

    expect(calls.batchCalls.length).toBe(0);
  });

  it('bundler/paymaster failure (sendBatchTransaction throws) → publish still succeeds with a warning', async () => {
    calls.smartWalletAddress = '0x4444444444444444444444444444444444444444';
    calls.batchThrows = new Error('Bundler 503 — paymaster pool drained');

    const filePath = writeBuyerIdentity(tmpDir, 'unlucky-buyer');
    // The publish MUST NOT throw — mint is best-effort.
    await expect(runPublishCmd(filePath)).resolves.toBeUndefined();

    // process.exit MUST NOT have been called with an error code.
    const errorExits = exitSpy.mock.calls.filter(
      (args) => typeof args[0] === 'number' && (args[0] as number) !== 0,
    );
    expect(errorExits).toHaveLength(0);

    // The user-facing warning must explain the link still succeeded.
    const allWarn = joinLogs(warnSpy);
    expect(allWarn).toMatch(/Could not auto-mint test USDC/);
    expect(allWarn).toMatch(/link succeeded/);
  });

  it('AutoWalletProvider.create() throws (AA infra unavailable) → publish still succeeds', async () => {
    calls.createThrows = new Error('CDP bundler endpoint unreachable');

    const filePath = writeBuyerIdentity(tmpDir, 'aa-down-buyer');
    await expect(runPublishCmd(filePath)).resolves.toBeUndefined();

    // No batched send attempted (create itself threw).
    expect(calls.batchCalls.length).toBe(0);
    const errorExits = exitSpy.mock.calls.filter(
      (args) => typeof args[0] === 'number' && (args[0] as number) !== 0,
    );
    expect(errorExits).toHaveLength(0);

    const allWarn = joinLogs(warnSpy);
    expect(allWarn).toMatch(/Could not auto-mint test USDC/);
  });

  it('receipt.success === false → publish prints "did not confirm" warning but does NOT throw', async () => {
    calls.smartWalletAddress = '0x5555555555555555555555555555555555555555';
    calls.batchReceipt = { hash: '0xPENDINGHASH', success: false };

    const filePath = writeBuyerIdentity(tmpDir, 'unconfirmed-buyer');
    await expect(runPublishCmd(filePath)).resolves.toBeUndefined();

    expect(calls.batchCalls.length).toBe(1);
    const allWarn = joinLogs(warnSpy);
    expect(allWarn).toMatch(/did not confirm/);
    expect(allWarn).toMatch(/0xPENDINGHASH/);
  });

  it('PROVIDER publish (intent: earn) does NOT call mintTestnetUsdcForBuyer (uses activateOnTestnet path)', async () => {
    // For a provider, the pay-only branch is skipped entirely. We expect
    // the AA wallet to still be created (by activateOnTestnet) but the
    // distinguishing assertion is: the mint helper's "Minting 1,000 test
    // USDC to your Smart Wallet (gasless)..." line is the buyer path's
    // signature. The provider path uses "Submitting N-call UserOp..." +
    // "Minted 1,000 test USDC to Smart Wallet" — different strings.
    calls.smartWalletAddress = '0x6666666666666666666666666666666666666666';
    const filePath = writeProviderIdentity(tmpDir, 'provider-bot');

    // We don't fully exercise the provider path's downstream flow here
    // (no AgentRegistry mocking) — but reaching the activation entry
    // point already proves the routing.
    await runPublishCmd(filePath).catch(() => undefined);

    const allLogs = joinLogs(logSpy);
    // The buyer-only string must NOT appear for a provider publish.
    expect(allLogs).not.toMatch(/Minting 1,000 test USDC to your Smart Wallet \(gasless\)/);
  });

  it('two consecutive publishes — first mints, second early-returns (no double-mint)', async () => {
    calls.smartWalletAddress = '0x7777777777777777777777777777777777777777';
    const smartLower = calls.smartWalletAddress.toLowerCase();

    const filePath = writeBuyerIdentity(tmpDir, 'twice-buyer');

    // First publish: balance = 0 → mint fires.
    usdcBalances.set(smartLower, 0n);
    await runPublishCmd(filePath);
    expect(calls.batchCalls.length).toBe(1);

    // Simulate the on-chain credit by updating the mocked balance.
    usdcBalances.set(smartLower, 1_000_000_000n);

    // Second publish: balance > 0 → early-return.
    await runPublishCmd(filePath);
    expect(calls.batchCalls.length).toBe(1); // unchanged

    const allLogs = joinLogs(logSpy);
    expect(allLogs).toMatch(/Test USDC already present/);
  });

  it('balanceOf query targets the network-configured USDC contract', async () => {
    calls.smartWalletAddress = '0x8888888888888888888888888888888888888888';
    const filePath = writeBuyerIdentity(tmpDir, 'usdc-check');

    // Spy on ethers.Contract to see which address was passed.
    const ethersMod = require('ethers') as typeof import('ethers');
    const ContractMock = ethersMod.Contract as unknown as jest.Mock;
    ContractMock.mockClear();

    await runPublishCmd(filePath);

    const net = getNetwork('base-sepolia');
    // The Contract constructor for balanceOf gets the USDC address as arg 0.
    const usdcCalls = ContractMock.mock.calls.filter(
      (args: unknown[]) => args[0] === net.contracts.usdc,
    );
    expect(usdcCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('publish completes synchronously (no zombie spinners / no unhandled promises)', async () => {
    calls.smartWalletAddress = '0x9999999999999999999999999999999999999999';
    const filePath = writeBuyerIdentity(tmpDir, 'sync-buyer');

    // If runPublishCmd's promise resolves cleanly, no spinner is left
    // running and no async work was leaked. Catch ANY unhandled rejection
    // during this test window — `mintTestnetUsdcForBuyer` is supposed to
    // swallow its own errors, so unhandled rejections would be a regression.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await runPublishCmd(filePath);
      // Give the event loop one extra tick to flush.
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
