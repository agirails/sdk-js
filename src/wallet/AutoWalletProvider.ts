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
  EIP712TypedData,
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
import { X402SignatureFailedError } from '../errors/X402Errors';

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
  // Lazy-constructed viem Coinbase Smart Account for EIP-712 signing (x402 v2).
  // Null until first signTypedData() call. Never reconstructed after creation.
  // I2: concurrent signTypedData calls share a single init promise to avoid
  // double-constructing the viem account (which would open two RPC clients
  // and run parity checks twice).
  private viemSmartAccount: unknown = null;
  private viemSmartAccountInit: Promise<unknown> | null = null;

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
   * Expose the underlying ethers JsonRpcProvider for read-only contract calls.
   * Used by X402Adapter to check USDC.allowance() before Permit2 approve so
   * we don't re-sponsor the same approve across restarts or horizontal scale.
   */
  getReadProvider(): unknown {
    return this.provider;
  }

  /**
   * Sign EIP-712 typed data via viem's `toCoinbaseSmartAccount`.
   *
   * Handles the full Smart Wallet signing flow automatically:
   *   1. Hash typed data (domain + types + message)
   *   2. Wrap in Coinbase Smart Wallet replay-safe hash
   *      (CoinbaseSmartWalletMessage struct with verifyingContract=SmartWallet)
   *   3. Owner EOA signs the replay-safe hash
   *   4. Encode as `SignatureWrapper(ownerIndex=0, rawSig)` for deployed wallet
   *   5. For counterfactual (undeployed) wallet, wrap in ERC-6492 envelope
   *      so facilitators can validate via simulation before first UserOp
   *
   * Required by X402Adapter for x402 v2 payments (EIP-3009 + Permit2 flows).
   *
   * Lazy-constructs the viem account on first call and caches it on the
   * instance via a shared init promise (I2: concurrent callers wait on the
   * same promise instead of double-constructing). Includes a runtime parity
   * check between our counterfactual address (`computeSmartWalletAddress`)
   * and viem's `toCoinbaseSmartAccount.getAddress()` — divergence would mean
   * signatures validate at the wrong contract, which is a silent failure
   * we refuse to allow.
   *
   * Bundler compatibility note (N3): this method uses `require('viem')` at
   * runtime so ACTP-only users never pay viem's ~80KB bundle cost. Under
   * webpack/esbuild/Next.js this `require` will not be resolved unless viem
   * is declared as an external. For Node applications (the primary target
   * for @agirails/sdk) it works out of the box.
   */
  async signTypedData(typedData: EIP712TypedData): Promise<string> {
    try {
      const account = await this.getViemSmartAccount();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sig: string = await (account as any).signTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });
      return sig;
    } catch (e) {
      if (e instanceof X402SignatureFailedError) throw e;
      throw new X402SignatureFailedError(
        `AutoWallet signTypedData failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /**
   * Lazily construct (and cache) the viem Smart Account used for EIP-712
   * signing. Uses an init promise so concurrent calls share the same
   * construction and parity check.
   */
  private async getViemSmartAccount(): Promise<unknown> {
    if (this.viemSmartAccount) return this.viemSmartAccount;

    if (!this.viemSmartAccountInit) {
      this.viemSmartAccountInit = this.constructViemSmartAccount();
    }

    try {
      const account = await this.viemSmartAccountInit;
      this.viemSmartAccount = account;
      return account;
    } catch (e) {
      // Reset on failure so the next caller can retry (otherwise a single
      // RPC hiccup would poison all future signTypedData calls forever).
      this.viemSmartAccountInit = null;
      throw e;
    }
  }

  private async constructViemSmartAccount(): Promise<unknown> {
    // Dynamic require to avoid pulling viem into the call path of
    // ACTP-only users who never touch x402.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createPublicClient, http } = require('viem');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { privateKeyToAccount } = require('viem/accounts');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { toCoinbaseSmartAccount } = require('viem/account-abstraction');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const viemChains = require('viem/chains');

    // I4: chain mapping MUST stay in sync with X402Adapter's DEFAULT_EVM_NETWORKS.
    // Any EVM chain we advertise as supported at the adapter layer must also
    // resolve to a viem chain here, or signing will fail after successful
    // requirement selection.
    const chainMap: Record<number, unknown> = {
      1: viemChains.mainnet,
      8453: viemChains.base,
      84532: viemChains.baseSepolia,
      10: viemChains.optimism,
      42161: viemChains.arbitrum,
      137: viemChains.polygon,
    };
    const chain = chainMap[this.chainId];

    if (!chain) {
      throw new X402SignatureFailedError(
        `AutoWalletProvider.signTypedData: chainId ${this.chainId} is not a ` +
          `supported x402 chain. Add to viem/chains mapping in AutoWalletProvider.`
      );
    }

    // Build viem public client against the same RPC URL as our ethers provider.
    // ethers v6 stores the RPC URL in provider._getConnection().url.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpcUrl = (this.provider as any)._getConnection?.()?.url;
    if (!rpcUrl) {
      throw new X402SignatureFailedError(
        'Cannot extract RPC URL from ethers provider for viem client construction'
      );
    }

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    // Owner LocalAccount from the same private key as our ethers signer.
    const owner = privateKeyToAccount(this.signer.privateKey as `0x${string}`);

    const account = await toCoinbaseSmartAccount({
      client: publicClient,
      owners: [owner],
      ownerIndex: 0,
      // nonce: 0n — default matches CoinbaseSmartWalletFactory.getAddress(..., 0)
    });

    // CRITICAL parity check: viem-computed Smart Wallet address MUST match
    // our counterfactual address. If these differ, signatures validate at
    // the wrong contract and everything fails silently on the facilitator side.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viemAddr: string = await (account as any).getAddress();
    if (viemAddr.toLowerCase() !== this.smartWalletAddress.toLowerCase()) {
      throw new X402SignatureFailedError(
        `Smart Wallet address parity mismatch: ours=${this.smartWalletAddress}, ` +
          `viem=${viemAddr}. Our computeSmartWalletAddress and viem's ` +
          `toCoinbaseSmartAccount disagree. x402 payments cannot proceed — ` +
          `signatures would validate at the wrong contract.`
      );
    }

    return account;
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
      'function createTransaction(address provider, address requester, uint256 amount, uint256 deadline, uint256 disputeWindow, bytes32 serviceHash, uint256 agentId, uint256 requesterAgentId)',
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
          BigInt(params.requesterAgentId || '0'),
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
