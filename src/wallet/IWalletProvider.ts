/**
 * IWalletProvider — Wallet abstraction for ACTP SDK.
 *
 * Enables pluggable wallet implementations:
 * - EOAWalletProvider (Tier 2): Direct ethers.Wallet signing
 * - AutoWalletProvider (Tier 1): CoinbaseSmartWallet + Paymaster (gasless)
 *
 * @module wallet/IWalletProvider
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Low-level transaction request.
 * Plain strings only — no ethers or viem types at the interface boundary.
 */
export interface TransactionRequest {
  /** Target contract address (0x-prefixed) */
  to: string;
  /** Calldata (0x-prefixed hex) */
  data: string;
  /** ETH value in wei (decimal string). Defaults to "0". */
  value?: string;
}

/**
 * Transaction receipt returned after submission.
 */
export interface TransactionReceipt {
  /** Transaction hash (EOA) or UserOp hash (AA) */
  hash: string;
  /** Whether the transaction succeeded */
  success: boolean;
}

/**
 * Wallet tier — determines gas behavior.
 */
export type WalletTier = 'auto' | 'eoa';

/**
 * Information about the wallet provider.
 */
export interface WalletInfo {
  /** The account address used for ACTP transactions */
  address: string;
  /** Wallet tier */
  tier: WalletTier;
  /** Whether this wallet supports atomic batching (AA = true, EOA = false) */
  supportsBatching: boolean;
  /** Whether gas is sponsored (AA with paymaster = true) */
  gasSponsored: boolean;
  /** Chain ID */
  chainId: number;
}

/**
 * Result of a batched ACTP payment via AA wallet.
 */
export interface BatchedPayResult {
  /** Pre-computed ACTP transaction ID (bytes32) */
  txId: string;
  /** Transaction hash from the UserOp */
  hash: string;
  /** Whether the UserOp succeeded */
  success: boolean;
}

/**
 * Parameters for batched ACTP payment.
 */
export interface BatchedPayParams {
  provider: string;
  requester: string;
  amount: string;
  deadline: number;
  disputeWindow: number;
  serviceHash: string;
  agentId: string;
  contracts: {
    usdc: string;
    actpKernel: string;
    escrowVault: string;
  };
}

// ============================================================================
// Interface
// ============================================================================

/**
 * Wallet provider interface.
 *
 * All methods use plain strings (no ethers/viem types) to keep the
 * interface decoupled from any specific library.
 */
export interface IWalletProvider {
  /**
   * Get the account address used as requester in ACTP transactions.
   * For AA wallets this is the Smart Wallet address (not the signer EOA).
   */
  getAddress(): string;

  /**
   * Send a single transaction.
   */
  sendTransaction(tx: TransactionRequest): Promise<TransactionReceipt>;

  /**
   * Send multiple transactions atomically (AA) or sequentially (EOA).
   *
   * AA wallets batch all calls into a single UserOp.
   * EOA wallets execute them one by one and return the last receipt.
   */
  sendBatchTransaction(txs: TransactionRequest[]): Promise<TransactionReceipt>;

  /**
   * Get wallet metadata.
   */
  getWalletInfo(): WalletInfo;

  /**
   * Execute a batched ACTP payment atomically (approve + createTx + linkEscrow).
   *
   * Only available on AA wallets (supportsBatching: true).
   * Handles ACTP nonce management internally via the DualNonceManager mutex.
   *
   * Returns undefined if batched payments are not supported.
   */
  payACTPBatched?(params: BatchedPayParams): Promise<BatchedPayResult>;
}
