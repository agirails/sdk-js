import { Contract, Interface, Signer, BytesLike, ethers, AbiCoder } from 'ethers';
import ACTPKernelABI from '../abi/ACTPKernel.json';

/**
 * Legacy 16-field tuple shape for `getTransaction` — matches what's
 * deployed on Base Mainnet (kernel `0x132B…2d29`, deployed 2026-02-09)
 * and what was canonical through SDK 2.7.0. The current 19-field ABI
 * (`requesterAgentId`, `disputeInitiator`, `disputeBond` appended)
 * doesn't decode against the older deployment, so we keep this
 * Interface as a fallback that ethers can decode against when the
 * primary call returns BAD_DATA.
 *
 * When this fallback is used, the three new fields are absent —
 * `Transaction` type already declares them optional / accepts undefined
 * (see types/transaction.ts).
 */
const LEGACY_GET_TRANSACTION_IFACE = new Interface([
  'function getTransaction(bytes32 transactionId) view returns ((bytes32 transactionId,address requester,address provider,uint8 state,uint256 amount,uint256 createdAt,uint256 updatedAt,uint256 deadline,bytes32 serviceHash,address escrowContract,bytes32 escrowId,bytes32 attestationUID,uint256 disputeWindow,bytes32 metadata,uint16 platformFeeBpsLocked,uint256 agentId))',
]);
import {
  State,
  StateMachine,
  Transaction,
  CreateTransactionParams,
  DisputeResolution,
  EconomicParams
} from '../types';
import {
  TransactionNotFoundError,
  TransactionRevertedError,
  InvalidStateTransitionError,
  ValidationError
} from '../errors';
import {
  validateAddress,
  validateAmount,
  validateDeadline,
  validateDisputeWindow,
  validateTxId
} from '../utils/validation';

/**
 * Gas options for transactions
 */
interface GasOptions {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/**
 * ACTPKernel - Smart contract wrapper
 * Reference: Yellow Paper §3 (ACTP Kernel Specification)
 */
export class ACTPKernel {
  private contract: Contract;
  private readonly gasSettings?: GasOptions;
  /**
   * Number of block confirmations to wait after each state-changing tx.
   * Default: 2 (Base L2 reorg safety — ~4-6 s on Base's 2 s blocks).
   * Set to 1 for faster feedback on testnet; never set to 0 in production.
   */
  private readonly confirmations: number;

  constructor(
    private readonly address: string,
    signer: Signer,
    gasSettings?: GasOptions,
    confirmations: number = 2
  ) {
    if (confirmations < 1) {
      throw new Error(`confirmations must be >= 1, got ${confirmations}`);
    }
    this.contract = new Contract(address, ACTPKernelABI, signer);
    this.gasSettings = gasSettings;
    this.confirmations = confirmations;
  }

  /**
   * Get kernel contract address
   */
  getAddress(): string {
    return this.address;
  }

  /**
   * Get the underlying ethers Contract instance.
   *
   *Security: Provides public access to contract for EventMonitor
   * instead of accessing private field via bracket notation.
   *
   * @returns ethers Contract instance
   */
  getContract(): Contract {
    return this.contract;
  }

  /**
   * Get gas buffer multiplier based on operation complexity
   * V6 Security Enhancement: Operation-specific gas buffers
   * Reference: SDK_SECURITY_ANALYSIS-Ultra-Think.md Lines 326-337
   */
  private getGasBufferMultiplier(operation: string): number {
    const buffers: Record<string, number> = {
      'createTransaction': 1.15,  // 15% - Simple state initialization
      'transitionState': 1.20,    // 20% - Standard state change
      'releaseEscrow': 1.30,      // 30% - Multi-recipient disbursement
      'raiseDispute': 1.25,       // 25% - Large proof data handling
      'resolveDispute': 1.30,     // 30% - Complex multi-party settlement
      'cancelTransaction': 1.15,  // 15% - Simple state change
      'anchorAttestation': 1.15   // 15% - Simple attestation anchoring
    };

    return buffers[operation] || 1.20; // Default 20% for unknown operations
  }

  /**
   * Build transaction options with gas settings and estimated gas
   * V6 Enhancement: Dynamic buffer based on operation type
   *
   *Security: Gas estimation manipulation attack protection
   * - Enforces operation-specific minimum gas floors (not global 100k)
   * - Validates gas limit doesn't exceed block gas limit (DoS prevention)
   * - Uses safe BigInt arithmetic with overflow detection
   * - Prevents floating-point arithmetic (uses BPS - basis points)
   */
  private buildTxOptions(estimatedGas: bigint, operation: string = 'default'): any {
    // Security: Operation-specific minimum gas floors
    // Malicious contracts could return artificially low gas estimates to cause txs to fail
    const MIN_GAS_FLOORS: Record<string, bigint> = {
      'createTransaction': 120000n,   // Create + event emission
      'transitionState': 80000n,      // State update + event
      'releaseEscrow': 220000n,       // Multi-recipient disbursement + events
      'raiseDispute': 100000n,        // Large proof data encoding
      'resolveDispute': 250000n,      // Complex multi-party settlement
      'cancelTransaction': 60000n,    // Simple state change
      'anchorAttestation': 80000n,    // Attestation storage
      'default': 100000n              // Conservative fallback
    };

    const minFloor = MIN_GAS_FLOORS[operation] || MIN_GAS_FLOORS['default'];
    const safeEstimate = estimatedGas > minFloor ? estimatedGas : minFloor;

    const bufferMultiplier = this.getGasBufferMultiplier(operation);

    // Security: Safe BigInt arithmetic using BPS (basis points)
    // Multiply by (bufferMultiplier * 10000) and divide by 10000
    // Example: 1.15x = (115 * 10000) / 10000 = 11500 / 10000
    // This avoids floating-point precision issues entirely
    const bufferNumerator = BigInt(Math.floor(bufferMultiplier * 10000));
    const bufferDenominator = 10000n;
    const gasLimit = (safeEstimate * bufferNumerator) / bufferDenominator;

    // Security: Overflow detection
    // After multiplication and division, result MUST be >= original estimate
    if (gasLimit < safeEstimate) {
      throw new Error(
        `Gas calculation overflow detected for operation "${operation}". ` +
        `Estimate: ${safeEstimate}, Buffer: ${bufferMultiplier}x, Result: ${gasLimit}. ` +
        `This indicates an arithmetic overflow - please report this bug.`
      );
    }

    // Security: Block gas limit check (Base L2 = 30M gas)
    // Prevents DoS by requesting excessive gas that can never be included
    const MAX_BLOCK_GAS_LIMIT = 30_000_000n;
    if (gasLimit > MAX_BLOCK_GAS_LIMIT) {
      throw new Error(
        `Gas limit ${gasLimit} exceeds maximum block gas limit ${MAX_BLOCK_GAS_LIMIT} for operation "${operation}". ` +
        `This transaction cannot be executed on-chain. ` +
        `Estimated gas: ${estimatedGas}, Min floor: ${minFloor}, Buffer: ${bufferMultiplier}x.`
      );
    }

    const options: any = {
      gasLimit
    };

    if (this.gasSettings?.maxFeePerGas) {
      options.maxFeePerGas = this.gasSettings.maxFeePerGas;
    }
    if (this.gasSettings?.maxPriorityFeePerGas) {
      options.maxPriorityFeePerGas = this.gasSettings.maxPriorityFeePerGas;
    }

    return options;
  }

  /**
   * Create a new transaction
   * Reference: Yellow Paper §3.4.1
   *
   * Contract signature: createTransaction(provider, requester, amount, deadline, disputeWindow, serviceHash, agentId)
   * Returns: bytes32 transactionId (generated by contract)
   */
  async createTransaction(params: CreateTransactionParams): Promise<{ txId: string; ethTxHash: string }> {
    const {
      provider,
      requester,
      amount,
      deadline,
      disputeWindow,
      metadata = '0x0000000000000000000000000000000000000000000000000000000000000000',
      agentId = '0',  // Default to 0 (not an ERC-8004 agent)
      requesterAgentId = '0'  // AIP-14: Requester's ERC-8004 agent ID
    } = params;

    // Input validation
    validateAddress(provider, 'provider');
    validateAddress(requester, 'requester');
    validateAmount(amount, 'amount');
    validateDeadline(deadline, 'deadline');
    validateDisputeWindow(disputeWindow, 'disputeWindow');

    try {
      // ethers v6: use getFunction() for typed access
      const createTxFunc = this.contract.getFunction('createTransaction');

      // Contract signature: createTransaction(provider, requester, amount, deadline, disputeWindow, serviceHash, agentId, requesterAgentId)
      const estimatedGas = await createTxFunc.estimateGas(
        provider,
        requester,
        amount,
        deadline,
        disputeWindow,
        metadata,  // serviceHash
        BigInt(agentId),  // ERC-8004 agent ID (0 = not an agent)
        BigInt(requesterAgentId)  // AIP-14: Requester's agent ID
      );

      // Build tx options with gas settings (15% buffer for simple state initialization)
      const txOptions = this.buildTxOptions(estimatedGas, 'createTransaction');

      // Per ABI: createTransaction returns transactionId directly
      // Contract signature: function createTransaction(...) external returns (bytes32 transactionId)
      const tx = await createTxFunc(
        provider,
        requester,
        amount,
        deadline,
        disputeWindow,
        metadata,  // serviceHash
        BigInt(agentId),  // ERC-8004 agent ID
        BigInt(requesterAgentId),  // AIP-14: Requester's agent ID
        txOptions
      );

      const receipt = await tx.wait(this.confirmations);
      if (!receipt) {
        throw new Error('Transaction receipt not available');
      }

      // Extract transactionId from TransactionCreated event
      // Event signature: TransactionCreated(bytes32 indexed transactionId, address indexed requester, address indexed provider, ...)
      //
      // DOCUMENTATION (CRITICAL-3): Note parameter order difference:
      // - Function: createTransaction(provider, requester, ...) - provider is first
      // - Event: TransactionCreated(txId, requester, provider, ...) - requester is first after txId
      // This is INTENTIONAL - function names main actor (provider), event logs initiator first (requester)
      // SDK correctly uses named args (parsedLog.args.transactionId) to avoid confusion
      for (const log of receipt.logs) {
        try {
          const parsedLog = this.contract.interface.parseLog({
            topics: [...log.topics],
            data: log.data
          });

          if (parsedLog && parsedLog.name === 'TransactionCreated') {
            // Use named arg for clarity (avoids index confusion with swapped provider/requester)
            const actpTxId = parsedLog.args.transactionId || parsedLog.args[0];
            return { txId: actpTxId, ethTxHash: receipt.hash };
          }
        } catch (e) {
          // Skip logs that don't match our interface
          continue;
        }
      }

      throw new Error('TransactionCreated event not found in receipt');
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

  /**
   * Transition transaction state
   * Reference: Yellow Paper §3.2
   */
  async transitionState(
    txId: string,
    newState: State,
    proof: BytesLike = '0x'
  ): Promise<void> {
    // Input validation
    validateTxId(txId, 'txId');

    // Validate transition
    const currentTx = await this.getTransaction(txId);
    if (!StateMachine.isValidTransition(currentTx.state, newState)) {
      const validStates = StateMachine.getNextValidStates(currentTx.state).map((s) =>
        State[s]
      );
      throw new InvalidStateTransitionError(currentTx.state, newState, validStates);
    }

    try {
      // ethers v6: use getFunction()
      const transitionFunc = this.contract.getFunction('transitionState');

      // Estimate gas with safety buffer (20% for standard state transitions)
      const estimatedGas = await transitionFunc.estimateGas(txId, newState, proof);
      const txOptions = this.buildTxOptions(estimatedGas, 'transitionState');

      const tx = await transitionFunc(txId, newState, proof, txOptions);

      await tx.wait(this.confirmations);
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

  /**
   * Submit quote for transaction (AIP-2)
   * Reference: AIP-2 §4.1 (Provider workflow)
   *
   * Transitions transaction from INITIATED → QUOTED with quote hash stored on-chain
   *
   * @param txId - Transaction ID (bytes32)
   * @param quoteHash - Keccak256 hash of canonical JSON quote message
   */
  async submitQuote(txId: string, quoteHash: string): Promise<void> {
    // Input validation
    validateTxId(txId, 'txId');

    if (!/^0x[a-fA-F0-9]{64}$/.test(quoteHash)) {
      throw new ValidationError('quoteHash', 'Must be valid bytes32 hex string');
    }

    if (quoteHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      throw new ValidationError('quoteHash', 'Cannot be zero hash');
    }

    // Validate current state is INITIATED
    const currentTx = await this.getTransaction(txId);
    if (currentTx.state !== State.INITIATED) {
      throw new InvalidStateTransitionError(
        currentTx.state,
        State.QUOTED,
        ['INITIATED']
      );
    }

    // Encode quote hash as bytes proof
    const abiCoder = AbiCoder.defaultAbiCoder();
    const proof = abiCoder.encode(['bytes32'], [quoteHash]);

    // Transition to QUOTED state with quote hash
    await this.transitionState(txId, State.QUOTED, proof);
  }

  /**
   * Link escrow to transaction
   *
   * CRITICAL: This is the ONLY way to create escrow per AIP-3 spec.
   * SDK should NOT call EscrowVault.createEscrow() directly (onlyKernel modifier).
   *
   * What happens internally:
   * 1. ACTPKernel validates transaction state, permissions, deadline
   * 2. Kernel calls IEscrowValidator(escrowContract).createEscrow(...)
   * 3. EscrowVault pulls USDC from consumer (must approve USDC first!)
   * 4. Events emitted: EscrowLinked
   * 5. **State transition behavior varies** (see below)
   *
   * STATE TRANSITION BEHAVIOR:
   * - **AIP-3 Spec (Source Code)**: Should auto-transition INITIATED/QUOTED → COMMITTED
   * - **Deployed Contract**: Behavior is INCONSISTENT - sometimes auto-transitions, sometimes doesn't
   * - **Recommended Practice**: Always check state after linkEscrow() and manually transition if needed
   *
   * ```typescript
   * await client.kernel.linkEscrow(txId, escrowVault, escrowId);
   * let tx = await client.kernel.getTransaction(txId);
   * if (tx.state !== State.COMMITTED) {
   *   await client.kernel.transitionState(txId, State.COMMITTED);
   * }
   * ```
   *
   * Prerequisites:
   * - Transaction in INITIATED or QUOTED state
   * - Consumer has approved USDC to EscrowVault address
   *   (use EscrowVault.approveToken() before calling this)
   *
   * @param txId - Transaction ID (bytes32)
   * @param escrowContract - EscrowVault contract address
   * @param escrowId - Unique escrow identifier (bytes32, consumer-generated)
   * @throws {ValidationError} If inputs invalid
   * @throws {TransactionRevertedError} If state invalid, deadline passed, or insufficient USDC
   *
   * @example
   * ```typescript
   * // Step 1: Approve USDC to EscrowVault (NOT to Kernel!)
   * await client.escrow.approveToken(BASE_SEPOLIA.contracts.usdc, amount);
   *
   * // Step 2: Generate unique escrow ID
   * const escrowId = ethers.id(`escrow-${Date.now()}`);
   *
   * // Step 3: Link escrow (creates escrow + auto-transitions to COMMITTED)
   * await client.kernel.linkEscrow(txId, escrowVaultAddress, escrowId);
   *
   * // Step 4: Verify state is COMMITTED (auto-transitioned, no manual call needed)
   * const tx = await client.kernel.getTransaction(txId);
   * expect(tx.state).to.equal(State.COMMITTED);
   * ```
   *
   * Reference: Yellow Paper §3.4.2, AIP-3 §3.2 (ACTPKernel.sol lines 244-276)
   */
  async linkEscrow(
    txId: string,
    escrowContract: string,
    escrowId: string
  ): Promise<void> {
    // Input validation
    validateTxId(txId, 'txId');
    validateAddress(escrowContract, 'escrowContract');
    validateTxId(escrowId, 'escrowId'); // escrowId is also bytes32

    try {
      // ethers v6: use getFunction()
      const linkEscrowFunc = this.contract.getFunction('linkEscrow');

      // Estimate gas with safety buffer (20% for linking escrow)
      const estimatedGas = await linkEscrowFunc.estimateGas(txId, escrowContract, escrowId);
      const txOptions = this.buildTxOptions(estimatedGas, 'transitionState');

      const tx = await linkEscrowFunc(txId, escrowContract, escrowId, txOptions);

      await tx.wait(this.confirmations);
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

  /**
   * Release milestone payment
   *
   *Security: Contract ABI has only 2 params (txId, amount), not 3.
   * The milestoneId is NOT part of the current ACTPKernel V1 contract.
   * Per ABI: releaseMilestone(bytes32 transactionId, uint256 amount)
   *
   * @param txId - Transaction ID (bytes32)
   * @param amount - Amount to release (uint256)
   * @deprecated milestoneId parameter - removed as contract doesn't support it
   */
  async releaseMilestone(
    txId: string,
    amount: bigint
  ): Promise<void> {
    // Input validation
    validateTxId(txId, 'txId');
    validateAmount(amount, 'amount');

    try {
      // ethers v6: use getFunction()
      const releaseMilestoneFunc = this.contract.getFunction('releaseMilestone');

      // Security: Contract only takes 2 params (txId, amount)
      // Estimate gas with safety buffer (30% for escrow release operations)
      const estimatedGas = await releaseMilestoneFunc.estimateGas(txId, amount);
      const txOptions = this.buildTxOptions(estimatedGas, 'releaseEscrow');

      const tx = await releaseMilestoneFunc(txId, amount, txOptions);

      await tx.wait(this.confirmations);
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

  /**
   * Release full escrow (settle transaction)
   *
   * ⚠️ CRITICAL SECURITY WARNING (C-2): Attestation UID Validation Bypass
   *
   * **DO NOT call this method directly from your application code!**
   *
   * ACTPKernel V1 contract accepts any attestationUID without validation.
   * A malicious provider can:
   * - Submit an attestation from a different transaction
   * - Re-use an old attestation (replay attack)
   * - Submit a forged attestation with fake delivery proof
   *
   * **REQUIRED: Use secure wrapper methods instead:**
   *
   * 1. **BasicAdapter.completePayment()** (recommended for most users)
   *    - Automatically verifies attestation before release
   *    - Validates attestation belongs to this transaction
   *    - Checks attestation hasn't been used before
   *    - Handles all state transitions
   *
   * 2. **StandardAdapter.releaseEscrow()** (for more control)
   *    - Explicitly requires attestation verification
   *    - Throws error if attestation invalid or missing
   *    - Allows custom verification logic
   *
   * 3. **Manual verification** (advanced users only):
   *    ```typescript
   *    // Step 1: Get transaction details
   *    const tx = await kernel.getTransaction(txId);
   *
   *    // Step 2: Verify attestation if EAS is configured
   *    if (easHelper && tx.attestationUID && tx.attestationUID !== '0x0...0') {
   *      const isValid = await easHelper.verifyDeliveryAttestation(
   *        tx.attestationUID,
   *        tx.requester
   *      );
   *      if (!isValid) {
   *        throw new Error('Invalid or fraudulent delivery attestation');
   *      }
   *    }
   *
   *    // Step 3: Only now is it safe to release
   *    await kernel.releaseEscrow(txId);
   *    ```
   *
   * **Why this matters:**
   * - Without verification, you risk paying for work never delivered
   * - Provider can steal funds by re-using attestations from other transactions
   * - No on-chain enforcement (contract V1 limitation, fixed in V2)
   *
   * **For testnet/mainnet deployments:**
   * - MUST configure easConfig in ACTPClient
   * - MUST use wrapper methods (Basic/Standard adapters)
   * - NEVER call this method directly unless attestation verified
   *
   * @param txId - Transaction ID to settle
   * @throws {ValidationError} If txId is invalid
   * @throws {TransactionRevertedError} If contract reverts
   *
   * @see {@link BasicAdapter.completePayment} Recommended method with built-in verification
   * @see {@link StandardAdapter.releaseEscrow} Explicit verification method
   * @see {@link EASHelper.verifyDeliveryAttestation} Manual verification helper
   */
  async releaseEscrow(txId: string): Promise<void> {
    // Input validation
    validateTxId(txId, 'txId');

    try {
      // ethers v6: use getFunction()
      const releaseEscrowFunc = this.contract.getFunction('releaseEscrow');

      // Estimate gas with safety buffer (30% for escrow release operations)
      const estimatedGas = await releaseEscrowFunc.estimateGas(txId);
      const txOptions = this.buildTxOptions(estimatedGas, 'releaseEscrow');

      const tx = await releaseEscrowFunc(txId, txOptions);

      await tx.wait(this.confirmations);
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

  /**
   * Get transaction by ID
   */
  async getTransaction(txId: string): Promise<Transaction> {
    let txData: any;
    try {
      txData = await this.contract.getTransaction(txId);
    } catch (error: any) {
      const reason = error?.reason || error?.shortMessage || error?.message || '';

      // Deployed kernel reverts on missing transactions (e.g., "Tx missing")
      if (typeof reason === 'string' && reason.toLowerCase().includes('tx missing')) {
        throw new TransactionNotFoundError(txId);
      }

      // Decode failure → fall back to legacy 16-field ABI. The deployed
      // Base Mainnet kernel (and any older test deployments) returns
      // the older tuple shape that the current 19-field ABI can't
      // decode. Without this fallback every call against an older
      // deployment surfaces as a generic decode error, and downstream
      // BlockchainRuntime.getTransaction silently swallows it as
      // "transaction not found" — provider sees TX_NOT_FOUND for a
      // real on-chain tx. (Damir review report 2026-04-18, Issue A.)
      const isDecodeFailure =
        error?.code === 'BAD_DATA' ||
        (typeof reason === 'string' &&
          reason.toLowerCase().includes('could not decode result data'));
      if (isDecodeFailure) {
        // Surface the contract's reader (provider) for the legacy call.
        // contract.runner is a Signer in our normal construction; it
        // exposes `.provider` for read-only calls.
        const runner = (this.contract as unknown as { runner?: { provider?: unknown } }).runner;
        const readProvider = (runner?.provider ?? runner) as ethers.ContractRunner | null;
        if (!readProvider) {
          throw new Error(
            `Failed to fetch transaction ${txId}: contract decode failed and no read provider available for legacy fallback`,
          );
        }
        try {
          const legacyContract = new Contract(this.address, LEGACY_GET_TRANSACTION_IFACE, readProvider);
          txData = await legacyContract.getTransaction(txId);
        } catch (legacyError: any) {
          const legacyReason = legacyError?.reason || legacyError?.shortMessage || legacyError?.message || '';
          if (typeof legacyReason === 'string' && legacyReason.toLowerCase().includes('tx missing')) {
            throw new TransactionNotFoundError(txId);
          }
          throw new Error(
            `Failed to fetch transaction ${txId} (legacy fallback also failed): ${typeof legacyReason === 'string' ? legacyReason : String(legacyReason)}`,
          );
        }
      } else {
        throw new Error(
          `Failed to fetch transaction ${txId}: ${typeof reason === 'string' ? reason : String(reason)}`
        );
      }
    }

    // Check if transaction exists (createdAt !== 0)
    if (txData.createdAt === 0 || txData.createdAt === 0n) {
      throw new TransactionNotFoundError(txId);
    }

    // Parse agentId - convert BigInt to string, 0n means "not an ERC-8004 agent"
    const agentIdValue = typeof txData.agentId === 'bigint'
      ? txData.agentId.toString()
      : txData.agentId?.toString();

    return {
      txId: txData.transactionId,
      requester: txData.requester,
      provider: txData.provider,
      amount: txData.amount,
      state: (typeof txData.state === 'bigint' ? Number(txData.state) : txData.state) as State,
      createdAt: typeof txData.createdAt === 'bigint' ? Number(txData.createdAt) : txData.createdAt,
      updatedAt: typeof txData.updatedAt === 'bigint' ? Number(txData.updatedAt) : txData.updatedAt,
      deadline: typeof txData.deadline === 'bigint' ? Number(txData.deadline) : txData.deadline,
      disputeWindow: typeof txData.disputeWindow === 'bigint' ? Number(txData.disputeWindow) : txData.disputeWindow,
      escrowContract: txData.escrowContract,
      escrowId: txData.escrowId,
      serviceHash: txData.serviceHash,
      attestationUID: txData.attestationUID,
      // Use metadata field (quote hash for QUOTED state) if available, fallback to serviceHash
      metadata: txData.metadata || txData.serviceHash,
      platformFeeBpsLocked:
        typeof txData.platformFeeBpsLocked === 'bigint'
          ? Number(txData.platformFeeBpsLocked)
          : txData.platformFeeBpsLocked,
      // ERC-8004 agent ID (undefined or '0' means not an ERC-8004 agent)
      agentId: agentIdValue && agentIdValue !== '0' ? agentIdValue : undefined,
      // AIP-14: requester agent ID
      requesterAgentId: (() => {
        const v = typeof txData.requesterAgentId === 'bigint'
          ? txData.requesterAgentId.toString()
          : txData.requesterAgentId?.toString();
        return v && v !== '0' ? v : undefined;
      })()
    };
  }

  /**
   * Get economic parameters (fee structure)
   *
   *Security: Contract doesn't have getEconomicParams() function.
   * Must call individual getters: platformFeeBps(), requesterPenaltyBps(), feeRecipient()
   * Per ACTPKernel.json ABI lines 576-586, 619-630, 351-361
   */
  async getEconomicParams(): Promise<EconomicParams> {
    // Security: Call individual view functions in parallel
    // Contract ABI has: platformFeeBps(), requesterPenaltyBps(), feeRecipient()
    // NOT a combined getEconomicParams() function
    const [platformFeeBps, requesterPenaltyBps, feeRecipient] = await Promise.all([
      this.contract.platformFeeBps(),
      this.contract.requesterPenaltyBps(),
      this.contract.feeRecipient()
    ]);

    return {
      baseFeeNumerator: Number(platformFeeBps),
      baseFeeDenominator: 10000, // BPS is always out of 10000
      feeRecipient: feeRecipient,
      requesterPenaltyBps: Number(requesterPenaltyBps),
      providerPenaltyBps: 0 // Not in current contract ABI, will be added in future version
    };
  }

  /**
   * Estimate gas for transaction creation
   */
  async estimateCreateTransaction(params: CreateTransactionParams): Promise<bigint> {
    const {
      provider,
      requester,
      amount,
      deadline,
      disputeWindow,
      metadata = '0x0000000000000000000000000000000000000000000000000000000000000000',
      agentId = '0',
      requesterAgentId = '0'  // AIP-14
    } = params;

    // ethers v6: use getFunction()
    const createTxFunc = this.contract.getFunction('createTransaction');
    return await createTxFunc.estimateGas(
      provider,
      requester,
      amount,
      deadline,
      disputeWindow,
      metadata,
      BigInt(agentId),
      BigInt(requesterAgentId)  // AIP-14
    );
  }

  /**
   * Raise dispute on delivered transaction
   * Reference: Yellow Paper §3.4 (Dispute Management)
   */
  async raiseDispute(txId: string, reason: string, evidence: string): Promise<void> {
    validateTxId(txId, 'txId');

    // Encode dispute proof with reason and evidence (IPFS hash)
    const abiCoder = AbiCoder.defaultAbiCoder();
    const proofData = abiCoder.encode(
      ['string', 'string'],
      [reason, evidence]
    );

    try {
      // ethers v6: use getFunction()
      const transitionFunc = this.contract.getFunction('transitionState');

      // Estimate gas with safety buffer (25% for large proof data)
      const estimatedGas = await transitionFunc.estimateGas(
        txId,
        State.DISPUTED,
        proofData
      );

      const txOptions = this.buildTxOptions(estimatedGas, 'raiseDispute');

      const tx = await transitionFunc(
        txId,
        State.DISPUTED,
        proofData,
        txOptions
      );

      await tx.wait(this.confirmations);
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

  /**
   * Resolve/settle dispute with payment split
   * Reference: Yellow Paper §3.4
   *
   * Disputes are settled via transitionState(SETTLED, proof) per §3.2
   * The kernel contract decodes the proof and handles escrow disbursement
   */
  async resolveDispute(txId: string, resolution: DisputeResolution): Promise<void> {
    validateTxId(txId, 'txId');

    const { requesterAmount, providerAmount, mediatorAmount, mediator } = resolution;

    // Validate amounts are non-negative
    if (requesterAmount < 0n || providerAmount < 0n || mediatorAmount < 0n) {
      throw new Error('Dispute resolution amounts cannot be negative');
    }

    // Validate mediator address if mediator amount > 0
    if (mediatorAmount > 0n) {
      if (!mediator) {
        throw new Error('Mediator address required when mediator amount > 0');
      }
      validateAddress(mediator, 'mediator');
    }

    // Encode resolution proof (128 bytes: 2x uint256 + address + uint256)
    // AUDIT FIX (2026-02): Contract expects: (uint256, uint256, address, uint256)
    // = [requesterAmount, providerAmount, mediator, mediatorAmount]
    // See ACTPKernel.sol _decodeResolutionProof() line 654-655
    const abiCoder = AbiCoder.defaultAbiCoder();
    const proofData = abiCoder.encode(
      ['uint256', 'uint256', 'address', 'uint256'],
      [
        requesterAmount,
        providerAmount,
        mediator || ethers.getAddress('0x0000000000000000000000000000000000000000'),
        mediatorAmount
      ]
    );

    try {
      // ethers v6: use getFunction()
      const transitionFunc = this.contract.getFunction('transitionState');

      // Settle dispute via state transition to SETTLED with resolution proof (30% buffer)
      const estimatedGas = await transitionFunc.estimateGas(
        txId,
        State.SETTLED,
        proofData
      );

      const txOptions = this.buildTxOptions(estimatedGas, 'resolveDispute');

      const tx = await transitionFunc(
        txId,
        State.SETTLED,
        proofData,
        txOptions
      );

      await tx.wait(this.confirmations);
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

  /**
   * Settle disputed transaction (alias for resolveDispute)
   */
  async settleDispute(txId: string, resolution: DisputeResolution): Promise<void> {
    return this.resolveDispute(txId, resolution);
  }

  /**
   * Anchor an EAS attestation UID to a transaction (delivery proof)
   * Reference: AIP-4 (Delivery Proof and EAS Attestation Standard)
   *
   * @param txId - Transaction ID
   * @param attestationUID - EAS attestation UID from provider
   * @throws {ValidationError} If inputs are invalid
   * @throws {TransactionRevertedError} If contract reverts
   *
   * @example
   * ```typescript
   * const easHelper = new EASHelper(signer, easConfig);
   * const attestation = await easHelper.attestDeliveryProof(proof, recipient);
   * await kernel.anchorAttestation(txId, attestation.uid);
   * ```
   */
  async anchorAttestation(txId: string, attestationUID: string): Promise<void> {
    validateTxId(txId, 'txId');

    // Validate attestationUID format (32-byte hex string)
    if (!attestationUID || !/^0x[a-fA-F0-9]{64}$/.test(attestationUID)) {
      throw new ValidationError('attestationUID', 'Must be 32-byte hex string (0x...)');
    }

    try {
      // ethers v6: use getFunction()
      const anchorFunc = this.contract.getFunction('anchorAttestation');

      const estimatedGas = await anchorFunc.estimateGas(
        txId,
        attestationUID
      );

      const txOptions = this.buildTxOptions(estimatedGas, 'anchorAttestation');

      const tx = await anchorFunc(
        txId,
        attestationUID,
        txOptions
      );

      await tx.wait(this.confirmations);
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }


  /**
   * Accept a provider's quote and update transaction amount.
   *
   * This is a dedicated on-chain function (NOT a transitionState wrapper).
   * It updates the transaction amount to the quoted amount and locks the
   * current platformFeeBps, but does NOT change the transaction state
   * (stays in QUOTED). After acceptQuote, call linkEscrow to move to COMMITTED.
   *
   * Reference: ACTPKernel.sol acceptQuote()
   *
   * @param txId - Transaction ID (bytes32)
   * @param newAmount - New amount agreed upon (uint256, in USDC wei)
   * @throws {ValidationError} If inputs are invalid
   * @throws {TransactionRevertedError} If contract reverts (wrong state, wrong caller, etc.)
   *
   * @example
   * ```typescript
   * // Provider submits quote (INITIATED -> QUOTED)
   * await kernel.submitQuote(txId, quoteHash);
   *
   * // Requester accepts the quoted amount
   * await kernel.acceptQuote(txId, BigInt(2000000)); // 2 USDC
   *
   * // Now link escrow to commit (QUOTED -> COMMITTED)
   * await kernel.linkEscrow(txId, escrowVault, escrowId);
   * ```
   */
  async acceptQuote(txId: string, newAmount: bigint): Promise<void> {
    // Input validation
    validateTxId(txId, 'txId');
    validateAmount(newAmount, 'newAmount');

    try {
      const acceptQuoteFunc = this.contract.getFunction('acceptQuote');

      const estimatedGas = await acceptQuoteFunc.estimateGas(txId, newAmount);
      const txOptions = this.buildTxOptions(estimatedGas, 'transitionState');

      const tx = await acceptQuoteFunc(txId, newAmount, txOptions);
      await tx.wait(this.confirmations);
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

}
