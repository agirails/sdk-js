import { ethers } from 'ethers';

// ============================================================================
// Security: RPC URL Configuration
// ============================================================================
// Environment variables take priority over hardcoded defaults.
// This prevents accidental API key leakage if developers modify this file.
// Public RPC endpoints are used as fallbacks for ease of use.
//
// Set these environment variables to use your own RPC provider:
//   BASE_SEPOLIA_RPC - Custom RPC for Base Sepolia testnet
//   BASE_MAINNET_RPC - Custom RPC for Base Mainnet
// ============================================================================

const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
// Default Base mainnet RPC: publicnode. `mainnet.base.org` is known to
// return response shapes that ethers v6.15.0 misinterprets as reverts
// with no data (specifically on ERC-4337 EntryPoint.getNonce during
// userOp preparation), breaking every new integrator's first mainnet
// settle. publicnode handles the same read with the same ethers version
// cleanly. (Damir review report 2026-04-18, Issue B.)
const BASE_MAINNET_RPC_URL = process.env.BASE_MAINNET_RPC || 'https://base-rpc.publicnode.com';

/**
 * True when the active network falls back to the bundled PUBLIC RPC (no
 * BASE_SEPOLIA_RPC / BASE_MAINNET_RPC override). Public RPCs serve one-shot
 * transactions fine but cap eth_getLogs (~2000 blocks) and garbage-collect
 * long-lived filters — so a 24/7 provider listener that watches on-chain may
 * silently miss jobs. Long-running listeners should warn on this.
 */
export function usingPublicRpc(network: string): boolean {
  const n = network.toLowerCase();
  if (n.includes('mock')) return false;
  if (n.includes('mainnet')) return !process.env.BASE_MAINNET_RPC;
  return !process.env.BASE_SEPOLIA_RPC; // testnet / base-sepolia / default
}

// Shared AA keys for out-of-the-box UX. These are PUBLIC keys — equivalent
// to Firebase web apiKey or a Stripe publishable key. The actual security
// boundary is enforced server-side by paymaster policies on the provider
// dashboards: gas sponsorship is restricted to AgentRegistry + X402Relay
// contract addresses, so a third party reusing these keys cannot drain
// the paymaster balance against arbitrary destinations.
//
// Heavy users should still set CDP_API_KEY / PIMLICO_API_KEY env vars to
// route through their own account for billing isolation and rate-limit
// headroom.
const CDP_CLIENT_KEY = process.env.CDP_API_KEY?.trim() || '2txciN85t41erCjveqgNnXYyHRcoo5xP';
const PIMLICO_KEY = process.env.PIMLICO_API_KEY?.trim() || 'pim_YiHmeAijzTPUvo1UMmXUiN';

function resolveOverrideUrl(url?: string): string | undefined {
  const trimmed = url?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveCoinbaseRpcUrl(networkPath: string, override?: string): string | undefined {
  const overrideUrl = resolveOverrideUrl(override);
  if (overrideUrl) return overrideUrl;
  return `https://api.developer.coinbase.com/rpc/v1/${networkPath}/${CDP_CLIENT_KEY}`;
}

function resolvePimlicoRpcUrl(chainId: number, override?: string): string | undefined {
  const overrideUrl = resolveOverrideUrl(override);
  if (overrideUrl) return overrideUrl;
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${PIMLICO_KEY}`;
}

/**
 * Network configuration
 */
export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  blockExplorer: string;
  contracts: {
    actpKernel: string;
    escrowVault: string;
    usdc: string;
    eas: string; // EAS contract address
    easSchemaRegistry: string; // EAS SchemaRegistry contract
    agentRegistry?: string; // AIP-7 Agent Registry (optional until deployed)
    identityRegistry?: string; // AIP-7 ERC-1056 DID Registry (optional until deployed)
    archiveTreasury?: string; // AIP-7 Archive Treasury for Arweave funding (optional until deployed)
    /**
     * @deprecated Legacy fee-splitting relay from the pre-v2 x402 flow.
     * The current X402Adapter routes payments directly buyer→seller via
     * @x402/fetch + facilitator (EIP-3009 / Permit2); this address is
     * retained only for third parties still calling the relay directly.
     * Scheduled for removal in the next breaking SDK major.
     */
    x402Relay?: string;
    erc8004IdentityRegistry?: string; // ERC-8004 Identity Registry (canonical CREATE2)
    // AIP-14b three-tier dispute system (P2-2). Undefined until the dispute
    // stack is deployed: testnet lands in Phase 6, mainnet later. Keys match
    // the Python SDK ContractAddresses (parity).
    bondEscalation?: string; // BondEscalation (Tier-1 bonded escalation + AIRuling verifier)
    compositeMediator?: string; // CompositeMediator (canonical 0/1/2 ruling → fund routing)
    umaOptimisticOracleV3?: string; // UMA OptimisticOracleV3 (Tier-2 optimistic oracle)
  };
  eas: {
    deliverySchemaUID: string; // AIP-4 delivery proof schema
    configSnapshotSchemaUID?: string; // AGIRAILS.md config snapshot schema
  };
  gasSettings: {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  };
  /**
   * Maximum transaction amount in USDC (human-readable, e.g., 100 = $100)
   *
   * SECURITY: Limits exposure on unaudited mainnet contracts.
   * Set to undefined for no limit (testnet only).
   */
  maxTransactionAmount?: number;

  /**
   * Known deployment block of the ACTPKernel contract.
   *
   * Eliminates the O(log N) binary-search over `getCode()` that
   * DualNonceManager otherwise performs on first nonce derivation.
   * If undefined, the binary search fallback is used.
   */
  actpKernelDeploymentBlock?: number;

  /**
   * AIP-12: Account Abstraction (AA) configuration.
   * EntryPoint v0.6 + CoinbaseSmartWallet.
   */
  aa?: {
    /** ERC-4337 EntryPoint v0.6 address */
    entryPoint: string;
    /** CoinbaseSmartWallet factory address */
    smartWalletFactory: string;
    /** Bundler RPC URLs */
    bundlerUrls: {
      coinbase?: string;
      pimlico?: string;
    };
    /** Paymaster RPC URLs (ERC-7677) */
    paymasterUrls: {
      coinbase?: string;
      pimlico?: string;
    };
  };
}

/**
 * Base Sepolia Testnet Configuration
 */
export const BASE_SEPOLIA: NetworkConfig = {
  name: 'Base Sepolia',
  chainId: 84532,
  rpcUrl: BASE_SEPOLIA_RPC_URL,
  blockExplorer: 'https://sepolia.basescan.org',
  contracts: {
    // Redeployed 2026-05-19 alongside mainnet to align ABI shape
    // (INV-30 disputeBondBpsLocked + AIP-14 / d9c6e8e requesterPenaltyBpsLocked).
    // See agirails/actp-kernel deployments/base-sepolia.json for details.
    actpKernel: '0x9d25A874f046185d9237Cd4954C88D2B74B0021b',
    escrowVault: '0x7dF07327090efcA73DCBa70414aA3131Fc6d2efB',
    usdc: '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb', // MockUSDC (unchanged)
    eas: '0x4200000000000000000000000000000000000021',
    easSchemaRegistry: '0x4200000000000000000000000000000000000020',
    agentRegistry: '0xD91F9aBfBf60b4a2Fd5317ab0cDF3F44faB5D656',
    identityRegistry: '0xce9749c768b425fab0daa0331047d1340ec99a88', // unchanged (no kernel ref)
    archiveTreasury: '0x2eE4f7bE289fc9EFC2F9f2D6E53e50abDF23A3eb',
    x402Relay: '0x110b25bb3d45c40dfcf34bb451aa7069b2a1cb3b', // deprecated; not redeployed
    erc8004IdentityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  },
  eas: {
    deliverySchemaUID: '0x1b0ebdf0bd20c28ec9d5362571ce8715a55f46e81c3de2f9b0d8e1b95fb5ffce'
  },
  gasSettings: {
    maxFeePerGas: ethers.parseUnits('2', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei')
  },
  actpKernelDeploymentBlock: 41725686, // 2026-05-19 V4 redeploy
  // AIP-12: Account Abstraction
  aa: {
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    smartWalletFactory: '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',
    bundlerUrls: {
      coinbase: resolveCoinbaseRpcUrl('base-sepolia', process.env.CDP_BUNDLER_URL),
      pimlico: resolvePimlicoRpcUrl(84532, process.env.PIMLICO_BUNDLER_URL),
    },
    paymasterUrls: {
      coinbase: resolveCoinbaseRpcUrl('base-sepolia', process.env.CDP_PAYMASTER_URL),
      pimlico: resolvePimlicoRpcUrl(84532, process.env.PIMLICO_PAYMASTER_URL),
    },
  },
};

/**
 * Base Mainnet Configuration
 */
export const BASE_MAINNET: NetworkConfig = {
  name: 'Base Mainnet',
  chainId: 8453,
  rpcUrl: BASE_MAINNET_RPC_URL,
  blockExplorer: 'https://basescan.org',
  contracts: {
    actpKernel: '0x048c811352e8a3fECd5b0Ec4AA2c2b94083CC842',
    escrowVault: '0x262D5912A9612F0c66dA5d13B4E678D50ebC44b5',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    eas: '0x4200000000000000000000000000000000000021',
    easSchemaRegistry: '0x4200000000000000000000000000000000000020',
    agentRegistry: '0x64Cb18bfb3CC1aCb1370a3B01613391D3561a009',
    archiveTreasury: '0x6159A80Ce8362aBB2307FbaB4Ed4D3F4A4231Acc',
    erc8004IdentityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
  eas: {
    deliverySchemaUID: '0x166501e7476e2fcf9214c4c5144533c2957d56fe59d639effc1719a0658d9c9a'
  },
  gasSettings: {
    maxFeePerGas: ethers.parseUnits('0.5', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('0.1', 'gwei')
  },
  /**
   * SECURITY: $1,000 max transaction limit for production safety.
   */
  maxTransactionAmount: 1000,
  actpKernelDeploymentBlock: 46212266,
  // AIP-12: Account Abstraction
  aa: {
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    smartWalletFactory: '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',
    bundlerUrls: {
      coinbase: resolveCoinbaseRpcUrl('base', process.env.CDP_BUNDLER_URL),
      pimlico: resolvePimlicoRpcUrl(8453, process.env.PIMLICO_BUNDLER_URL),
    },
    paymasterUrls: {
      coinbase: resolveCoinbaseRpcUrl('base', process.env.CDP_PAYMASTER_URL),
      pimlico: resolvePimlicoRpcUrl(8453, process.env.PIMLICO_PAYMASTER_URL),
    },
  },
};

/**
 * All supported networks
 */
export const NETWORKS: Record<string, NetworkConfig> = {
  'base-sepolia': BASE_SEPOLIA,
  'base-mainnet': BASE_MAINNET
};

/**
 * Get network configuration by name (returns deep clone to prevent mutation)
 */
export function getNetwork(network: string): NetworkConfig {
  const config = NETWORKS[network];
  if (!config) {
    throw new Error(
      `Unknown network: ${network}. Supported networks: ${Object.keys(NETWORKS).join(', ')}`
    );
  }

  // Validate that contracts are deployed (not zero addresses)
  validateNetworkConfig(config);

  // Deep clone to prevent global mutation
  return {
    name: config.name,
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    blockExplorer: config.blockExplorer,
    contracts: {
      actpKernel: config.contracts.actpKernel,
      escrowVault: config.contracts.escrowVault,
      usdc: config.contracts.usdc,
      eas: config.contracts.eas,
      easSchemaRegistry: config.contracts.easSchemaRegistry,
      agentRegistry: config.contracts.agentRegistry,
      identityRegistry: config.contracts.identityRegistry,
      archiveTreasury: config.contracts.archiveTreasury,
      x402Relay: config.contracts.x402Relay,
      erc8004IdentityRegistry: config.contracts.erc8004IdentityRegistry,
      bondEscalation: config.contracts.bondEscalation,
      compositeMediator: config.contracts.compositeMediator,
      umaOptimisticOracleV3: config.contracts.umaOptimisticOracleV3
    },
    eas: {
      deliverySchemaUID: config.eas.deliverySchemaUID,
      configSnapshotSchemaUID: config.eas.configSnapshotSchemaUID
    },
    gasSettings: {
      maxFeePerGas: config.gasSettings.maxFeePerGas,
      maxPriorityFeePerGas: config.gasSettings.maxPriorityFeePerGas
    },
    maxTransactionAmount: config.maxTransactionAmount,
    actpKernelDeploymentBlock: config.actpKernelDeploymentBlock,
    ...(config.aa ? {
      aa: {
        entryPoint: config.aa.entryPoint,
        smartWalletFactory: config.aa.smartWalletFactory,
        bundlerUrls: { ...config.aa.bundlerUrls },
        paymasterUrls: { ...config.aa.paymasterUrls },
      }
    } : {}),
  };
}

/**
 * Validate network name
 */
export function isValidNetwork(network: string): boolean {
  return network in NETWORKS;
}

/**
 * Validate that contract addresses are deployed (not zero addresses)
 *
 * @throws Error if any contract address is zero (0x000...000)
 */
export function validateNetworkConfig(config: NetworkConfig): void {
  const zeroAddress = '0x0000000000000000000000000000000000000000';
  const errors: string[] = [];

  if (config.contracts.actpKernel === zeroAddress) {
    errors.push('ACTPKernel address is zero - contracts not yet deployed to this network');
  }

  if (config.contracts.escrowVault === zeroAddress) {
    errors.push('EscrowVault address is zero - contracts not yet deployed to this network');
  }

  if (config.contracts.usdc === zeroAddress) {
    errors.push('USDC address is zero - token contract not configured for this network');
  }

  if (errors.length > 0) {
    throw new Error(
      `Network configuration error for ${config.name} (chainId: ${config.chainId}):\n\n` +
      errors.map(e => `  ✗ ${e}`).join('\n') +
      `\n\nContracts must be deployed before using the SDK. Please:\n` +
      `  1. Deploy contracts to ${config.name}\n` +
      `  2. Update src/config/networks.ts with deployed addresses\n` +
      `  3. Rebuild the SDK: npm run build`
    );
  }
}
