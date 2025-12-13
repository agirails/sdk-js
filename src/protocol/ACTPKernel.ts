import { Contract, Signer, BytesLike, ethers, AbiCoder } from 'ethers';
import ACTPKernelABI from '../abi/ACTPKernel.json';
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

  constructor(
    private readonly address: string,
    signer: Signer,
    gasSettings?: GasOptions
  ) {
    this.contract = new Contract(address, ACTPKernelABI, signer);
    this.gasSettings = gasSettings;
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
   * SECURITY FIX (C-3): Provides public access to contract for EventMonitor
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
   * SECURITY FIX (C-3): Gas estimation manipulation attack protection
   * - Enforces operation-specific minimum gas floors (not global 100k)
   * - Validates gas limit doesn't exceed block gas limit (DoS prevention)
   * - Uses safe BigInt arithmetic with overflow detection
   * - Prevents floating-point arithmetic (uses BPS - basis points)
   */
  private buildTxOptions(estimatedGas: bigint, operation: string = 'default'): any {
    // SECURITY FIX (C-3): Operation-specific minimum gas floors
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

    // SECURITY FIX (C-3): Safe BigInt arithmetic using BPS (basis points)
    // Multiply by (bufferMultiplier * 10000) and divide by 10000
    // Example: 1.15x = (115 * 10000) / 10000 = 11500 / 10000
    // This avoids floating-point precision issues entirely
    const bufferNumerator = BigInt(Math.floor(bufferMultiplier * 10000));
    const bufferDenominator = 10000n;
    const gasLimit = (safeEstimate * bufferNumerator) / bufferDenominator;

    // SECURITY FIX (C-3): Overflow detection
    // After multiplication and division, result MUST be >= original estimate
    if (gasLimit < safeEstimate) {
      throw new Error(
        `Gas calculation overflow detected for operation "${operation}". ` +
        `Estimate: ${safeEstimate}, Buffer: ${bufferMultiplier}x, Result: ${gasLimit}. ` +
        `This indicates an arithmetic overflow - please report this bug.`
      );
    }

    // SECURITY FIX (C-3): Block gas limit check (Base L2 = 30M gas)
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
   * Contract signature: createTransaction(provider, requester, amount, deadline, disputeWindow, serviceHash)
   * Returns: bytes32 transactionId (generated by contract)
   */
  async createTransaction(params: CreateTransactionParams): Promise<string> {
    const {
      provider,
      requester,
      amount,
      deadline,
      disputeWindow,
      metadata = '0x0000000000000000000000000000000000000000000000000000000000000000'
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

      // Contract signature: createTransaction(provider, requester, amount, deadline, disputeWindow, serviceHash)
      const estimatedGas = await createTxFunc.estimateGas(
        provider,
        requester,
        amount,
        deadline,
        disputeWindow,
        metadata  // serviceHash
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
        txOptions
      );

      const receipt = await tx.wait(2); // Wait for 2 confirmations (Base L2 reorg safety)
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
            return parsedLog.args.transactionId || parsedLog.args[0];
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

      await tx.wait(2); // Wait for 2 confirmations (Base L2 reorg safety)
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

      // Wait for 2 confirmations to ensure state is updated on RPC nodes (Base Sepolia reorg safety)
      await tx.wait(2);
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

  /**
   * Release milestone payment
   *
   * SECURITY FIX (CRITICAL-2): Contract ABI has only 2 params (txId, amount), not 3.
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

      // SECURITY FIX (CRITICAL-2): Contract only takes 2 params (txId, amount)
      // Estimate gas with safety buffer (30% for escrow release operations)
      const estimatedGas = await releaseMilestoneFunc.estimateGas(txId, amount);
      const txOptions = this.buildTxOptions(estimatedGas, 'releaseEscrow');

      const tx = await releaseMilestoneFunc(txId, amount, txOptions);

      await tx.wait(2); // Wait for 2 confirmations (Base L2 reorg safety)
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
   * 1. **BeginnerAdapter.completePayment()** (recommended for most users)
   *    - Automatically verifies attestation before release
   *    - Validates attestation belongs to this transaction
   *    - Checks attestation hasn't been used before
   *    - Handles all state transitions
   *
   * 2. **IntermediateAdapter.releaseEscrow()** (for more control)
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
   * - MUST use wrapper methods (Beginner/Intermediate adapters)
   * - NEVER call this method directly unless attestation verified
   *
   * @param txId - Transaction ID to settle
   * @throws {ValidationError} If txId is invalid
   * @throws {TransactionRevertedError} If contract reverts
   *
   * @see {@link BeginnerAdapter.completePayment} Recommended method with built-in verification
   * @see {@link IntermediateAdapter.releaseEscrow} Explicit verification method
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

      await tx.wait(2); // Wait for 2 confirmations (Base L2 reorg safety)
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

  /**
   * Get transaction by ID
   */
  async getTransaction(txId: string): Promise<Transaction> {
    const txData = await this.contract.getTransaction(txId);

    // Check if transaction exists (createdAt !== 0)
    if (txData.createdAt === 0 || txData.createdAt === 0n) {
      throw new TransactionNotFoundError(txId);
    }

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
          : txData.platformFeeBpsLocked
    };
  }

  /**
   * Get economic parameters (fee structure)
   *
   * SECURITY FIX (CRITICAL-4): Contract doesn't have getEconomicParams() function.
   * Must call individual getters: platformFeeBps(), requesterPenaltyBps(), feeRecipient()
   * Per ACTPKernel.json ABI lines 576-586, 619-630, 351-361
   */
  async getEconomicParams(): Promise<EconomicParams> {
    // SECURITY FIX (CRITICAL-4): Call individual view functions in parallel
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
    const { provider, requester, amount, deadline, disputeWindow, metadata = '0x0000000000000000000000000000000000000000000000000000000000000000' } = params;

    // ethers v6: use getFunction()
    const createTxFunc = this.contract.getFunction('createTransaction');
    return await createTxFunc.estimateGas(
      provider,
      requester,
      amount,
      deadline,
      disputeWindow,
      metadata
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

      await tx.wait(2); // Wait for 2 confirmations (Base L2 reorg safety)
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

    // Encode resolution proof (128 bytes: 3x uint256 + address)
    // Kernel contract will decode this in _decodeResolutionProof and disburse funds
    const abiCoder = AbiCoder.defaultAbiCoder();
    const proofData = abiCoder.encode(
      ['uint256', 'uint256', 'uint256', 'address'],
      [
        requesterAmount,
        providerAmount,
        mediatorAmount,
        mediator || ethers.getAddress('0x0000000000000000000000000000000000000000')
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

      await tx.wait(2); // Wait for 2 confirmations (Base L2 reorg safety)
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

      await tx.wait(2); // Wait for 2 confirmations (Base L2 reorg safety)
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

}
