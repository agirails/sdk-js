/**
 * AutoWalletProvider — Tier 1 (Auto) wallet implementation.
 *
 * Creates a CoinbaseSmartWallet with gas-sponsored transactions:
 *   1. Load/generate local encrypted key
 *   2. Derive Smart Wallet address (counterfactual CREATE2)
 *   3. Check AgentRegistry registration
 *   4. Build UserOp with executeBatch
 *   5. Get paymaster sponsorship (Coinbase → Pimlico fallback)
 *   6. Submit via bundler
 *
 * If agent is NOT registered, falls back to EOA behavior with a warning.
 *
 * @module wallet/AutoWalletProvider
 */

import { ethers } from 'ethers';
import {
  IWalletProvider,
  TransactionRequest,
  TransactionReceipt,
  WalletInfo,
  BatchedPayParams,
  BatchedPayResult,
  CreateACTPTransactionParams,
  CreateACTPTransactionResult,
} from './IWalletProvider';
import { computeSmartWalletAddress } from './aa/UserOpBuilder';
import {
  buildUserOp,
  signUserOp,
} from './aa/UserOpBuilder';
import { SmartWalletCall } from './aa/constants';
import { BundlerClient } from './aa/BundlerClient';
import { PaymasterClient } from './aa/PaymasterClient';
import { DualNonceManager } from './aa/DualNonceManager';
import { buildACTPPayBatch, computeTransactionId } from './aa/TransactionBatcher';
import { sdkLogger } from '../utils/Logger';

// ============================================================================
// Types
// ============================================================================

export interface AutoWalletConfig {
  /** Ethers signer (the EOA that owns the Smart Wallet) */
  signer: ethers.Wallet;
  /** Ethers provider */
  provider: ethers.JsonRpcProvider;
  /** Chain ID */
  chainId: number;
  /** ACTPKernel contract address (for ACTP nonce reads) */
  actpKernelAddress: string;
  /** Known deployment block of ACTPKernel (skips binary search in DualNonceManager) */
  actpKernelDeploymentBlock?: number;
  /** Bundler configuration */
  bundler: {
    primaryUrl: string;
    backupUrl?: string;
  };
  /** Paymaster configuration */
  paymaster: {
    primaryUrl: string;
    backupUrl?: string;
  };
}

// ============================================================================
// AutoWalletProvider
// ============================================================================

export class AutoWalletProvider implements IWalletProvider {
  private readonly signer: ethers.Wallet;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly chainId: number;
  private readonly bundler: BundlerClient;
  private readonly paymaster: PaymasterClient;
  private readonly nonceManager: DualNonceManager;
  private smartWalletAddress: string = '';
  private isDeployed: boolean = false;

  private constructor(
    config: AutoWalletConfig,
    smartWalletAddress: string,
    isDeployed: boolean
  ) {
    this.signer = config.signer;
    this.provider = config.provider;
    this.chainId = config.chainId;
    this.smartWalletAddress = smartWalletAddress;
    this.isDeployed = isDeployed;

    this.bundler = new BundlerClient({
      primaryUrl: config.bundler.primaryUrl,
      backupUrl: config.bundler.backupUrl,
    });

    this.paymaster = new PaymasterClient({
      primaryUrl: config.paymaster.primaryUrl,
      backupUrl: config.paymaster.backupUrl,
      chainId: config.chainId,
    });

    this.nonceManager = new DualNonceManager(
      config.provider,
      smartWalletAddress,
      config.actpKernelAddress,
      config.actpKernelDeploymentBlock
    );
  }

  /**
   * Factory method — computes counterfactual address and checks deployment.
   */
  static async create(config: AutoWalletConfig): Promise<AutoWalletProvider> {
    const signerAddress = config.signer.address;
    const smartWalletAddress = await computeSmartWalletAddress(
      signerAddress,
      config.provider
    );

    // Check if wallet is already deployed
    const code = await config.provider.getCode(smartWalletAddress);
    const isDeployed = code !== '0x';

    sdkLogger.info('AutoWalletProvider initialized', {
      signer: signerAddress,
      smartWallet: smartWalletAddress,
      deployed: isDeployed,
    });

    return new AutoWalletProvider(config, smartWalletAddress, isDeployed);
  }

  getAddress(): string {
    return this.smartWalletAddress;
  }

  async sendTransaction(tx: TransactionRequest): Promise<TransactionReceipt> {
    return this.sendBatchTransaction([tx]);
  }

  async sendBatchTransaction(
    txs: TransactionRequest[]
  ): Promise<TransactionReceipt> {
    if (txs.length === 0) {
      throw new Error('sendBatchTransaction requires at least one transaction');
    }

    // Convert to SmartWalletCall[]
    const calls: SmartWalletCall[] = txs.map((tx) => ({
      target: tx.to,
      value: tx.value ? BigInt(tx.value) : 0n,
      data: tx.data,
    }));

    // Use nonce manager for sequential ordering
    // Note: We don't know if this specific batch increments ACTP nonce
    // (that's handled at the ACTPClient level), so pass false here.
    // The caller (ACTPClient.payBatched) manages ACTP nonce tracking.
    return this.nonceManager.enqueue(
      async ({ entryPointNonce }) => {
        const receipt = await this.submitUserOp(calls, entryPointNonce);
        return { result: receipt, success: receipt.success };
      },
      false // ACTP nonce management is done at ACTPClient level
    );
  }

  getWalletInfo(): WalletInfo {
    return {
      address: this.smartWalletAddress,
      tier: 'auto',
      supportsBatching: true,
      gasSponsored: true,
      chainId: this.chainId,
    };
  }

  /**
   * Get the DualNonceManager (for ACTPClient to use for ACTP-aware batching).
   */
  getNonceManager(): DualNonceManager {
    return this.nonceManager;
  }

  /**
   * Check if the Smart Wallet is deployed on-chain.
   */
  getIsDeployed(): boolean {
    return this.isDeployed;
  }

  /**
   * Execute a batched ACTP payment atomically.
   *
   * Builds approve + createTransaction + linkEscrow as a single UserOp.
   * Manages ACTP nonce inside the mutex queue for concurrent safety.
   */
  async payACTPBatched(params: BatchedPayParams, prependCalls?: SmartWalletCall[]): Promise<BatchedPayResult> {
    return this.nonceManager.enqueue(
      async ({ entryPointNonce, actpNonce }) => {
        const MAX_NONCE_BUMPS = 12;
        let candidateNonce = actpNonce;

        for (let i = 0; i <= MAX_NONCE_BUMPS; i++) {
          const batch = buildACTPPayBatch({
            ...params,
            actpNonce: candidateNonce,
          });

          // Combine activation calls (if any) with payment calls
          const allCalls = prependCalls && prependCalls.length > 0
            ? [...prependCalls, ...batch.calls]
            : batch.calls;

          try {
            const receipt = await this.submitUserOp(allCalls, entryPointNonce);

            if (!receipt.success) {
              const failed: { result: BatchedPayResult; success: boolean } = {
                result: {
                  txId: batch.txId,
                  hash: receipt.hash,
                  success: false,
                },
                success: false,
              };
              return failed;
            }

            // Keep local nonce cache aligned with the nonce that actually succeeded.
            this.nonceManager.setCachedActpNonce(candidateNonce + 1n);

            const succeeded: { result: BatchedPayResult; success: boolean } = {
              result: {
                txId: batch.txId,
                hash: receipt.hash,
                success: receipt.success,
              },
              success: receipt.success,
            };
            return succeeded;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Bundlers may return either plain revert text or ABI-encoded revert data.
            const nonceCollision = /Escrow ID already used/i.test(message)
              || /457363726f7720494420616c72656164792075736564/i.test(message);

            if (!nonceCollision || i === MAX_NONCE_BUMPS) {
              throw error;
            }

            candidateNonce += 1n;
            sdkLogger.warn('ACTP nonce collision detected during batched pay; retrying with incremented nonce', {
              nextActpNonce: candidateNonce.toString(),
            });
          }
        }

        throw new Error('Unable to submit batched ACTP payment after nonce retries');
      },
      false // payACTPBatched controls ACTP nonce cache explicitly
    );
  }

  /**
   * Create an ACTP transaction via Smart Wallet (without escrow linking).
   *
   * Encodes just ACTPKernel.createTransaction() as a single-call UserOp.
   * Pre-computes the txId using the same keccak256 formula as the contract.
   * Manages ACTP nonce inside the mutex queue for concurrent safety.
   */
  async createACTPTransaction(params: CreateACTPTransactionParams): Promise<CreateACTPTransactionResult> {
    const kernelIface = new ethers.Interface([
      'function createTransaction(address provider, address requester, uint256 amount, uint256 deadline, uint256 disputeWindow, bytes32 serviceHash, uint256 agentId)',
    ]);

    return this.nonceManager.enqueue(
      async ({ entryPointNonce, actpNonce }) => {
        const txId = computeTransactionId(
          params.requester,
          params.provider,
          params.amount,
          params.serviceHash,
          actpNonce
        );

        const createTxData = kernelIface.encodeFunctionData('createTransaction', [
          params.provider,
          params.requester,
          BigInt(params.amount),
          params.deadline,
          params.disputeWindow,
          params.serviceHash,
          BigInt(params.agentId || '0'),
        ]);

        const calls: SmartWalletCall[] = [
          { target: params.contracts.actpKernel, value: 0n, data: createTxData },
        ];

        const receipt = await this.submitUserOp(calls, entryPointNonce);

        const result: CreateACTPTransactionResult = { txId, receipt };
        return { result, success: receipt.success };
      },
      true // createTransaction increments ACTP nonce
    );
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  /**
   * Build, sponsor, sign, and submit a UserOp.
   */
  private async submitUserOp(
    calls: SmartWalletCall[],
    entryPointNonce: bigint
  ): Promise<TransactionReceipt> {
    const signerAddress = this.signer.address;

    // 1. Build unsigned UserOp
    const userOp = buildUserOp({
      sender: this.smartWalletAddress,
      nonce: entryPointNonce,
      calls,
      isFirstDeploy: !this.isDeployed,
      signerAddress,
    });

    // 2. Get fee data
    const feeData = await this.provider.getFeeData();
    userOp.maxFeePerGas = feeData.maxFeePerGas ?? 2_000_000_000n;
    userOp.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1_000_000_000n;

    // 3. Get stub paymaster data (for gas estimation)
    const stubData = await this.paymaster.getPaymasterStubData(userOp);
    userOp.paymasterAndData = stubData.paymasterAndData;

    // 4. Dummy signature for gas estimation
    userOp.signature = dummySignature();

    // 5. Estimate gas
    const gasEstimate = await this.bundler.estimateUserOperationGas(userOp);
    userOp.callGasLimit = gasEstimate.callGasLimit;
    userOp.verificationGasLimit = gasEstimate.verificationGasLimit;
    userOp.preVerificationGas = gasEstimate.preVerificationGas;

    // 6. Get final paymaster data (with real gas values)
    const finalPaymaster = await this.paymaster.getPaymasterData(userOp);
    userOp.paymasterAndData = finalPaymaster.paymasterAndData;

    // 7. Sign
    userOp.signature = await signUserOp(userOp, this.signer, this.chainId);

    // 8. Submit
    const userOpHash = await this.bundler.sendUserOperation(userOp);
    sdkLogger.info('UserOp submitted', { userOpHash });

    // 9. Wait for receipt
    const receipt = await this.bundler.waitForReceipt(userOpHash);

    // Mark as deployed after first successful UserOp
    if (!this.isDeployed && receipt.success) {
      this.isDeployed = true;
    }

    return {
      hash: receipt.transactionHash,
      success: receipt.success,
    };
  }
}

/**
 * Dummy signature for gas estimation.
 * CoinbaseSmartWallet expects abi.encode(uint256 ownerIndex, bytes sig)
 * where sig is 65 bytes (r,s,v).
 */
function dummySignature(): string {
  const dummySig = '0x' + 'ff'.repeat(65);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'bytes'],
    [0, dummySig]
  );
}
