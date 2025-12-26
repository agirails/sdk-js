/**
 * request() - Basic API for service requesters
 *
 * The simplest way to request a service from AGIRAILS.
 * Specify what you need and your budget, and AGIRAILS finds a provider.
 *
 * @packageDocumentation
 */

import { ACTPClient } from '../ACTPClient';
import { RequestOptions, RequestResult } from '../level1/types/Options';
import { serviceDirectory } from './ServiceDirectory';
import { NoProviderFoundError, TimeoutError, ValidationError } from '../errors';
import { safeJSONParse, validateServiceName, isValidAddress } from '../utils/security';
import { Logger } from '../utils/Logger';
import { ethers } from 'ethers';

/**
 * Request a service
 *
 * This is the simplest way to request a service on AGIRAILS.
 * Specify the service name, input data, and budget, and AGIRAILS
 * handles finding a provider, creating the transaction, and delivering the result.
 *
 * @param service - Service name (e.g., 'translation', 'echo')
 * @param options - Request options (input, budget, etc.)
 * @returns Promise resolving to request result
 *
 * @throws {NoProviderFoundError} If no provider is found for the service
 * @throws {TimeoutError} If provider doesn't respond within timeout
 * @throws {ProviderRejectedError} If provider rejects the job
 * @throws {DeliveryFailedError} If provider fails to deliver result
 *
 * @example
 * ```typescript
 * // Simplest example
 * const { result } = await request('echo', {
 *   input: 'Hello, AGIRAILS!',
 *   budget: 1
 * });
 * console.log(result); // 'Hello, AGIRAILS!'
 *
 * // With progress callback
 * const { result } = await request('translation', {
 *   input: { text: 'Hello', from: 'en', to: 'de' },
 *   budget: 5,
 *   onProgress: (status) => {
 *     console.log(`${status.state}: ${status.progress}%`);
 *   }
 * });
 *
 * // With specific provider
 * const { result } = await request('image-gen', {
 *   input: { prompt: 'A beautiful sunset' },
 *   budget: 10,
 *   provider: '0x1234...abcd'
 * });
 * ```
 */
export async function request(
  service: string,
  options: RequestOptions
): Promise<RequestResult> {
  // SECURITY FIX (H-2): Validate service name to prevent injection
  const validatedService = validateServiceName(service);

  const logger = new Logger({ source: 'request' });

  // Find provider
  const provider = findProvider(validatedService, options.provider);

  if (!provider) {
    throw new NoProviderFoundError(validatedService, {
      availableProviders: serviceDirectory.findProviders(validatedService),
    });
  }

  // SECURITY FIX (RPCURL): Use rpcUrl from options or fallback to network default
  // This allows Level0 request() to work with testnet/mainnet without requiring
  // explicit rpcUrl if user is okay with public RPC endpoints.
  let rpcUrl = options.rpcUrl;
  if (!rpcUrl && (options.network === 'testnet' || options.network === 'mainnet')) {
    // Import getNetwork to get default rpcUrl from network config
    const { getNetwork } = await import('../config/networks');
    const networkName = options.network === 'testnet' ? 'base-sepolia' : 'base-mainnet';
    const networkConfig = getNetwork(networkName);
    rpcUrl = networkConfig.rpcUrl;
    logger.info(`Using default RPC URL for ${networkName}: ${rpcUrl}`);
  }

  // Create ACTP client
  const client = await ACTPClient.create({
    mode: options.network === 'testnet' ? 'testnet' : options.network === 'mainnet' ? 'mainnet' : 'mock',
    requesterAddress: getRequesterAddress(options.wallet),
    stateDirectory: options.stateDirectory,
    privateKey: getPrivateKey(options.wallet),
    rpcUrl,
  });

  // Calculate deadline
  const deadline = calculateDeadline(options.deadline, options.timeout);

  // Create transaction with service metadata
  const startTime = Date.now();

  try {
    const requesterAddress = getRequesterAddress(options.wallet);
    const amountWei = (options.budget * 1_000_000).toString(); // Convert to USDC wei (6 decimals)

    // In mock mode, ensure requester has enough funds
    // This is a convenience feature for testing - won't exist in production
    if (client.runtime && 'mintTokens' in client.runtime) {
      const mockRuntime = client.runtime as any;
      const balance = await mockRuntime.getBalance(requesterAddress);
      const balanceBigInt = BigInt(balance);
      const amountBigInt = BigInt(amountWei);

      if (balanceBigInt < amountBigInt) {
        // Mint enough tokens (with some buffer)
        const toMint = (amountBigInt - balanceBigInt + BigInt(10_000_000)).toString(); // +10 USDC buffer
        await mockRuntime.mintTokens(requesterAddress, toMint);
      }
    }

    // ARCHITECTURE FIX: Service metadata handling
    // - MockRuntime: Store plaintext for provider matching and input extraction
    // - BlockchainRuntime: Hashes plaintext internally before sending on-chain
    //
    // Provider needs plaintext to:
    // 1. Match service name to handler (findServiceHandler)
    // 2. Extract input data for job execution (extractJobInput)
    //
    // On-chain storage uses bytes32 hash (BlockchainRuntime.validateServiceHash handles this)
    const serviceMetadata = JSON.stringify({
      service: validatedService,
      input: options.input,
      timestamp: Date.now(),
    });

    // Create transaction with structured metadata
    // MockRuntime stores as-is, BlockchainRuntime hashes for on-chain
    const txId = await client.runtime.createTransaction({
      provider,
      requester: requesterAddress,
      amount: amountWei,
      deadline,
      disputeWindow: options.disputeWindow ?? 172800, // Default 2 days
      serviceDescription: serviceMetadata, // Structured JSON for provider parsing
    });

    // Call onProgress if provided
    if (options.onProgress) {
      options.onProgress({
        state: 'initiated',
        progress: 10,
        message: 'Transaction created, waiting for provider...',
      });
    }

    // Poll for DELIVERED state (provider completes the job)
    const maxWaitTime = options.timeout ?? 300000; // 5 minutes default
    const pollInterval = 2000; // 2 seconds
    const maxAttempts = Math.floor(maxWaitTime / pollInterval);

    let tx = await client.runtime.getTransaction(txId);
    let attempts = 0;

    while (tx && tx.state !== 'DELIVERED' && tx.state !== 'SETTLED' && attempts < maxAttempts) {
      // Check for terminal states that indicate failure
      if (tx.state === 'CANCELLED' || tx.state === 'DISPUTED') {
        throw new Error(`Transaction ${tx.state.toLowerCase()}`);
      }

      // Update progress
      if (options.onProgress) {
        const progress = 10 + Math.min(80, (attempts / maxAttempts) * 80);
        options.onProgress({
          state: tx.state.toLowerCase() as any,
          progress,
          message: `Waiting for delivery (${tx.state})...`,
        });
      }

      // Wait and poll again
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      tx = await client.runtime.getTransaction(txId);
      attempts++;
    }

    // Check if we got a result
    if (!tx || (tx.state !== 'DELIVERED' && tx.state !== 'SETTLED')) {
      const _timedOut = true; // Flag for potential future use

      // SECURITY FIX (H-3): Auto-cancel transaction on timeout if still in early state
      // This prevents funds from being locked indefinitely if provider never responds
      if (tx && (tx.state === 'INITIATED' || tx.state === 'COMMITTED')) {
        try {
          logger.warn('Transaction timed out, cancelling to release funds', {
            txId,
            state: tx.state,
          });

          // ACTUALLY CANCEL THE TRANSACTION
          // Check if runtime has cancelTransaction method
          if ('cancelTransaction' in client.runtime) {
            await (client.runtime as any).cancelTransaction(txId);
            logger.info('Transaction cancelled successfully', { txId });

            const error = new TimeoutError(maxWaitTime, `Transaction cancelled after timeout`);
            (error as any).txId = txId;
            (error as any).wasCancelled = true;
            throw error;
          } else {
            // Fallback: Transition to CANCELLED state
            await client.runtime.transitionState(txId, 'CANCELLED');
            logger.info('Transaction cancelled successfully (via transitionState)', { txId });

            const error = new TimeoutError(maxWaitTime, `Transaction cancelled after timeout`);
            (error as any).txId = txId;
            (error as any).wasCancelled = true;
            throw error;
          }
        } catch (cancelError) {
          logger.error('Failed to cancel timed-out transaction', { txId }, cancelError as Error);
          // Continue with original timeout error
        }
      }

      const error = new TimeoutError(maxWaitTime, `waiting for service '${validatedService}' delivery`);
      (error as any).txId = txId;
      (error as any).currentState = tx?.state || 'UNKNOWN';
      throw error;
    }

    // SECURITY FIX (C-3): Safe JSON parsing with schema validation
    // Extract result from delivery proof
    let deliveredResult: any = {};
    if (tx.deliveryProof) {
      // Define expected schema for delivery proof
      // NOTE: 'type' field with value 'delivery.proof' is the unique wrapper marker
      // (set by ProofGenerator.generateDeliveryProof) that handlers won't naturally return
      const DELIVERY_PROOF_SCHEMA: Record<string, string> = {
        result: 'any',
        data: 'any',
        metadata: 'object',
        proof: 'string',
        timestamp: 'number',
        contentHash: 'string',
        txId: 'string',
        type: 'string',  // Unique marker: 'delivery.proof'
      };

      // Use safeJSONParse with schema validation which:
      // 1. Validates JSON structure
      // 2. Removes __proto__, constructor, prototype properties
      // 3. Prevents prototype pollution attacks
      // 4. Validates against expected schema
      // 5. Checks size limits to prevent DoS
      // 6. Returns null if parsing fails
      const parsed = safeJSONParse(tx.deliveryProof, DELIVERY_PROOF_SCHEMA);

      if (parsed !== null) {
        deliveredResult = parsed;
      } else {
        // If parsing failed, treat as plain text (but don't execute or eval)
        deliveredResult = { data: tx.deliveryProof };
        logger.warn('Failed to parse delivery proof as JSON', { txId });
      }
    } else if (options.network === 'testnet' || options.network === 'mainnet') {
      // KNOWN LIMITATION: BlockchainRuntime doesn't fetch deliveryProof from IPFS yet
      // Result will be empty until this is implemented
      logger.warn(
        'Delivery proof retrieval not yet implemented for testnet/mainnet. ' +
        'Result may be empty. Use ACTPClient with manual proof handling for production.',
        { txId, network: options.network }
      );
    }

    // SECURITY FIX (CRITICAL-2): Release escrow only after proper validation
    // For mock mode, auto-release is safe. For testnet/mainnet, require attestation.
    if (tx.state === 'DELIVERED' && tx.escrowId) {
      // Wait for dispute window to expire
      const disputeWindowEnd = (tx.completedAt ?? 0) + tx.disputeWindow;
      const currentTime = client.runtime.time.now();

      if (currentTime >= disputeWindowEnd) {
        // SECURITY FIX (CRITICAL-2): Only auto-release in mock mode
        // For real networks, the requester should manually verify and release
        // or use attestation-based verification
        const isMockMode = options.network !== 'testnet' && options.network !== 'mainnet';

        if (isMockMode) {
          try {
            await client.runtime.releaseEscrow(tx.escrowId);
          } catch (error) {
            // Ignore if already released or dispute window still active
            // This is non-critical for result delivery
          }
        } else {
          // For testnet/mainnet, log a warning about manual verification
          logger.warn(
            'Auto-release disabled for non-mock networks. ' +
            'Verify delivery proof and call releaseEscrow() manually, ' +
            'or enable attestation verification in BlockchainRuntime.',
            { txId, escrowId: tx.escrowId, network: options.network }
          );
        }
      }
    }

    if (options.onProgress) {
      options.onProgress({
        state: 'settled',
        progress: 100,
        message: 'Transaction completed!',
      });
    }

    // Extract raw handler result from delivery proof wrapper
    // The delivery proof structure is: { type: 'delivery.proof', result: <handler_output>, ... }
    // We return the raw handler output as `result` for better DX
    //
    // IMPORTANT: We check for type === 'delivery.proof' which is the unique marker
    // set by ProofGenerator. This avoids false positives from handlers that happen
    // to return objects with result/contentHash/timestamp fields.
    const isDeliveryProofWrapper = deliveredResult !== null &&
                                   typeof deliveredResult === 'object' &&
                                   deliveredResult.type === 'delivery.proof' &&
                                   'result' in deliveredResult;
    const rawResult = isDeliveryProofWrapper ? deliveredResult.result : deliveredResult;

    const result: RequestResult = {
      result: rawResult,
      transaction: {
        id: txId,
        provider,
        amount: options.budget,
        fee: options.budget * 0.01, // 1% ACTP fee
        duration: Date.now() - startTime,
        proof: tx.deliveryProof ?? '',
      },
    };

    return result;
  } catch (error) {
    // Better error handling
    if (error instanceof TimeoutError) {
      throw error;
    }

    // Wrap unknown errors
    throw new Error(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Find provider for service
 *
 * @param service - Service name
 * @param providerOption - Provider selection strategy
 * @returns Provider address or undefined
 */
function findProvider(
  service: string,
  providerOption?: string | 'any' | 'best' | 'cheapest'
): string | undefined {
  // If specific provider specified, use it
  if (providerOption && providerOption !== 'any' && providerOption !== 'best' && providerOption !== 'cheapest') {
    return providerOption;
  }

  // Otherwise, find from service directory
  const providers = serviceDirectory.findProviders(service);

  if (providers.length === 0) {
    return undefined;
  }

  // For MVP, just return the first provider
  // In V2, implement 'best' and 'cheapest' strategies
  return providers[0];
}

/**
 * Get requester address from wallet option
 *
 * SECURITY FIX (HIGH): Properly derive addresses from private keys using ethers
 * Never fabricate addresses or use partial key slices as addresses.
 *
 * @param wallet - Wallet configuration
 * @returns Ethereum address
 * @throws {ValidationError} If address format is invalid
 */
function getRequesterAddress(
  wallet?: 'auto' | 'connect' | string | { privateKey: string }
): string {
  // For mock mode only: generate deterministic address
  // This is only safe because mock mode doesn't involve real funds
  if (!wallet || wallet === 'auto') {
    // Create a valid Ethereum address (40 hex chars) - ONLY for mock mode
    const hex = Buffer.from('requester').toString('hex');
    return '0x' + hex.padEnd(40, '0');
  }

  if (wallet === 'connect') {
    throw new Error('Browser wallet connection not yet implemented');
  }

  if (typeof wallet === 'string') {
    // SECURITY FIX (HIGH): Validate address format
    if (!isValidAddress(wallet)) {
      throw new ValidationError('wallet', `Invalid Ethereum address format: ${wallet}`);
    }
    return wallet.toLowerCase();
  }

  // SECURITY FIX (HIGH): Derive address from private key using ethers
  // This is the correct way to get address from a private key
  try {
    const walletInstance = new ethers.Wallet(wallet.privateKey);
    return walletInstance.address.toLowerCase();
  } catch (error) {
    throw new ValidationError('wallet.privateKey', 'Invalid private key format');
  }
}

/**
 * Get private key from wallet option
 *
 * SECURITY FIX (HIGH): Validate private key format before use
 *
 * @param wallet - Wallet configuration
 * @returns Private key or undefined
 * @throws {ValidationError} If private key format is invalid
 */
function getPrivateKey(
  wallet?: 'auto' | 'connect' | string | { privateKey: string }
): string | undefined {
  if (!wallet || wallet === 'auto' || wallet === 'connect') {
    return undefined;
  }

  // If wallet is a string that looks like a private key (0x + 64 hex chars), use it
  // Otherwise treat it as an address and return undefined
  if (typeof wallet === 'string') {
    // Check if it looks like a private key (0x + 64 hex chars)
    if (/^0x[0-9a-fA-F]{64}$/.test(wallet)) {
      // Validate by trying to create a wallet
      try {
        new ethers.Wallet(wallet);
        return wallet;
      } catch {
        throw new ValidationError('wallet', 'Invalid private key format');
      }
    }
    // It's an address, not a private key
    return undefined;
  }

  // Validate private key format
  if (wallet.privateKey) {
    try {
      new ethers.Wallet(wallet.privateKey);
      return wallet.privateKey;
    } catch {
      throw new ValidationError('wallet.privateKey', 'Invalid private key format');
    }
  }

  return undefined;
}

/**
 * Calculate deadline timestamp
 *
 * @param deadline - Deadline option (timestamp or Date)
 * @param timeout - Timeout in milliseconds
 * @returns Deadline timestamp (seconds)
 */
function calculateDeadline(
  deadline?: number | Date,
  timeout: number = 300000 // 5 minutes default
): number {
  if (deadline) {
    if (deadline instanceof Date) {
      return Math.floor(deadline.getTime() / 1000);
    }
    return deadline;
  }

  // Default: now + timeout
  return Math.floor(Date.now() / 1000) + Math.floor(timeout / 1000);
}
