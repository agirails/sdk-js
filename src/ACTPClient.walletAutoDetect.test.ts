/**
 * Tests for wallet auto-detection logic in ACTPClient.create().
 *
 * When wallet is undefined (not explicitly set), the SDK should:
 * - Default to 'auto' when AA infrastructure (bundler + paymaster) is available
 * - Fall back to EOA when AA infrastructure is not available
 * - Respect explicit wallet: 'eoa' even when AA is available
 */

import { ACTPClient } from './ACTPClient';
import { getNetwork } from './config/networks';
import { AutoWalletProvider } from './wallet/AutoWalletProvider';
import { loadBuyerLink } from './config/buyerLink';

// --- Mocks ---

jest.mock('./config/networks', () => ({
  getNetwork: jest.fn(),
}));

jest.mock('./wallet/AutoWalletProvider', () => ({
  AutoWalletProvider: {
    create: jest.fn(),
  },
}));

jest.mock('./runtime/BlockchainRuntime', () => ({
  BlockchainRuntime: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    getEASHelper: jest.fn(),
  })),
}));

jest.mock('./config/pendingPublish', () => ({
  loadPendingPublish: jest.fn().mockReturnValue(null),
  deletePendingPublish: jest.fn(),
  getActpDir: jest.fn().mockReturnValue('/tmp/.actp'),
}));

jest.mock('./config/buyerLink', () => ({
  loadBuyerLink: jest.fn().mockReturnValue(null),
}));

// Prevent real JsonRpcProvider startup retries/noise in unit tests.
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  class MockJsonRpcProvider {
    constructor(_url?: string) {}
  }
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: MockJsonRpcProvider,
    },
  };
});

// Shared test private key (Hardhat #0, never use on mainnet)
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const MOCK_SMART_WALLET = '0x' + 'aa'.repeat(20);

function makeNetworkConfig(opts: { hasBundler: boolean; hasPaymaster: boolean }) {
  return {
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrl: 'https://rpc.example.com',
    contracts: {
      actpKernel: '0x' + '11'.repeat(20),
      escrowVault: '0x' + '22'.repeat(20),
      usdc: '0x' + '33'.repeat(20),
      agentRegistry: '0x' + '44'.repeat(20),
    },
    actpKernelDeploymentBlock: 1000,
    aa: {
      entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
      smartWalletFactory: '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',
      bundlerUrls: {
        coinbase: opts.hasBundler ? 'https://bundler.example.com' : undefined,
        pimlico: undefined,
      },
      paymasterUrls: {
        coinbase: opts.hasPaymaster ? 'https://paymaster.example.com' : undefined,
        pimlico: undefined,
      },
    },
  };
}

function setupAutoWalletMock() {
  (AutoWalletProvider.create as jest.Mock).mockResolvedValue({
    getAddress: () => MOCK_SMART_WALLET,
    getWalletInfo: () => ({ tier: 'auto', address: MOCK_SMART_WALLET }),
    isSmartWallet: () => true,
  });
}

describe('ACTPClient wallet auto-detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('wallet: undefined + AA available → auto-detects to auto', async () => {
    (getNetwork as jest.Mock).mockReturnValue(
      makeNetworkConfig({ hasBundler: true, hasPaymaster: true })
    );
    setupAutoWalletMock();

    const client = await ACTPClient.create({
      mode: 'testnet',
      privateKey: TEST_PRIVATE_KEY,
      // wallet not set — should auto-detect
      contracts: { agentRegistry: '' }, // bypass registry gate, isolate wallet mode detection
    });

    expect(client.info.walletTier).toBe('auto');
    expect(AutoWalletProvider.create).toHaveBeenCalled();
  });

  test('wallet: undefined + no bundler → stays EOA', async () => {
    (getNetwork as jest.Mock).mockReturnValue(
      makeNetworkConfig({ hasBundler: false, hasPaymaster: true })
    );

    const client = await ACTPClient.create({
      mode: 'testnet',
      privateKey: TEST_PRIVATE_KEY,
    });

    expect(client.info.walletTier).toBe('eoa');
    expect(AutoWalletProvider.create).not.toHaveBeenCalled();
  });

  test('wallet: undefined + no paymaster → stays EOA', async () => {
    (getNetwork as jest.Mock).mockReturnValue(
      makeNetworkConfig({ hasBundler: true, hasPaymaster: false })
    );

    const client = await ACTPClient.create({
      mode: 'testnet',
      privateKey: TEST_PRIVATE_KEY,
    });

    expect(client.info.walletTier).toBe('eoa');
    expect(AutoWalletProvider.create).not.toHaveBeenCalled();
  });

  test('wallet: "eoa" + AA available → respects explicit EOA', async () => {
    (getNetwork as jest.Mock).mockReturnValue(
      makeNetworkConfig({ hasBundler: true, hasPaymaster: true })
    );

    const client = await ACTPClient.create({
      mode: 'testnet',
      privateKey: TEST_PRIVATE_KEY,
      wallet: 'eoa',
    });

    expect(client.info.walletTier).toBe('eoa');
    expect(AutoWalletProvider.create).not.toHaveBeenCalled();
  });

  test('wallet: "auto" + AA available → works as before (explicit auto)', async () => {
    (getNetwork as jest.Mock).mockReturnValue(
      makeNetworkConfig({ hasBundler: true, hasPaymaster: true })
    );
    setupAutoWalletMock();

    const client = await ACTPClient.create({
      mode: 'testnet',
      privateKey: TEST_PRIVATE_KEY,
      wallet: 'auto',
      contracts: { agentRegistry: '' }, // bypass registry gate, isolate explicit auto behavior
    });

    expect(client.info.walletTier).toBe('auto');
    expect(AutoWalletProvider.create).toHaveBeenCalled();
  });

  // AIP-18 DEC-8: a pure buyer has no on-chain configHash and no
  // pending-publish, so the registry gate would normally drop it to EOA. The
  // buyer-link marker grants the gas-sponsored auto wallet anyway. (With a mock
  // provider the on-chain read throws, exercising the fail-open gate path,
  // where the buyer link is honoured exactly like a pending publish.)
  test('linked buyer (registry set, no configHash/pending) → auto (gasless)', async () => {
    (getNetwork as jest.Mock).mockReturnValue(
      makeNetworkConfig({ hasBundler: true, hasPaymaster: true })
    );
    setupAutoWalletMock();
    (loadBuyerLink as jest.Mock).mockReturnValue({
      version: 1,
      slug: 'my-buyer',
      wallet: '0x' + '11'.repeat(20),
      linkedAt: '2026-06-06T12:00:00.000Z',
    });

    const client = await ACTPClient.create({
      mode: 'testnet',
      privateKey: TEST_PRIVATE_KEY,
      wallet: 'auto',
      // registry left at the network default (non-empty) so the gate runs
    });

    expect(client.info.walletTier).toBe('auto');
    expect(AutoWalletProvider.create).toHaveBeenCalled();
  });

  test('unregistered non-buyer (no configHash/pending/link) → EOA', async () => {
    (getNetwork as jest.Mock).mockReturnValue(
      makeNetworkConfig({ hasBundler: true, hasPaymaster: true })
    );
    setupAutoWalletMock();
    (loadBuyerLink as jest.Mock).mockReturnValue(null);

    const client = await ACTPClient.create({
      mode: 'testnet',
      privateKey: TEST_PRIVATE_KEY,
      wallet: 'auto',
      // registry default (non-empty) → gate runs; no link → fail-closed to EOA
    });

    expect(client.info.walletTier).toBe('eoa');
  });
});
