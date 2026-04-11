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
 * Parameters for creating an ACTP transaction via Smart Wallet (without escrow).
 */
export interface CreateACTPTransactionParams {
  provider: string;
  requester: string;
  amount: string;
  deadline: number;
  disputeWindow: number;
  serviceHash: string;
  agentId: string;
  requesterAgentId?: string;
  contracts: {
    actpKernel: string;
  };
}

/**
 * Result of creating an ACTP transaction via Smart Wallet.
 */
export interface CreateACTPTransactionResult {
  /** Pre-computed ACTP transaction ID (bytes32) */
  txId: string;
  /** Transaction receipt */
  receipt: TransactionReceipt;
}

// EIP712TypedData lives in `src/types/eip712.ts` alongside other cross-cutting
// type definitions. Imported + re-exported here for backward compatibility
// with existing consumers that pull the type from this module.
import type { EIP712TypedData } from '../types/eip712';
export type { EIP712TypedData };

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
  requesterAgentId?: string;
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
   * @param params - Payment batch parameters
   * @param prependCalls - Optional calls to prepend (e.g., lazy publish activation)
   * @returns undefined if batched payments are not supported.
   */
  payACTPBatched?(params: BatchedPayParams, prependCalls?: import('./aa/constants').SmartWalletCall[]): Promise<BatchedPayResult>;

  /**
   * Create an ACTP transaction via Smart Wallet (without escrow linking).
   *
   * Only available on AA wallets (supportsBatching: true).
   * Handles ACTP nonce management internally via the DualNonceManager mutex.
   *
   * @param params - Transaction creation parameters
   * @returns Pre-computed txId and transaction receipt
   */
  createACTPTransaction?(params: CreateACTPTransactionParams): Promise<CreateACTPTransactionResult>;

  /**
   * Sign an EIP-712 typed data message.
   *
   * Optional — required for x402 v2 payments (both EIP-3009 and Permit2 flows).
   * EOA wallets delegate directly to `ethers.Wallet.signTypedData`. Smart Wallet
   * providers (Tier 1 / AA) wrap the signature via replay-safe hashing and
   * ERC-1271 / ERC-6492 encoding so the result validates on-chain via
   * `isValidSignature` calls to the Smart Wallet contract.
   *
   * Consumers (like X402Adapter) should check `typeof walletProvider.signTypedData === 'function'`
   * before attempting to use it.
   *
   * @param typedData - EIP-712 message to sign
   * @returns 0x-prefixed hex signature bytes
   */
  signTypedData?(typedData: EIP712TypedData): Promise<string>;
}
