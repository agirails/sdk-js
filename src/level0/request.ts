/**
 * request() - Simple tier API for service requesters
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
import { resolvePrivateKey } from '../wallet/keystore';
import { computeDisputeWindowEnds } from '../wallet/SmartWalletRouter';

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
  const validatedService = validateServiceName(service);

  const logger = new Logger({ source: 'request' });

  // Find provider
  const provider = findProvider(validatedService, options.provider);

  if (!provider) {
    throw new NoProviderFoundError(validatedService, {
      availableProviders: serviceDirectory.findProviders(validatedService),
    });
  }

  let rpcUrl = options.rpcUrl;
  if (!rpcUrl && (options.network === 'testnet' || options.network === 'mainnet')) {
    const { getNetwork } = await import('../config/networks');
    const networkName = options.network === 'testnet' ? 'base-sepolia' : 'base-mainnet';
    const networkConfig = getNetwork(networkName);
    rpcUrl = networkConfig.rpcUrl;
    logger.info(`Using default RPC URL for ${networkName}: ${rpcUrl}`);
  }

  const resolvedKey = await resolveKeyIfNeeded(options.wallet, options.network, options.stateDirectory);
  const resolvedAddress = resolvedKey
    ? ethers.getAddress(new ethers.Wallet(resolvedKey).address)
    : undefined;

  const client = await ACTPClient.create({
    mode: options.network === 'testnet' ? 'testnet' : options.network === 'mainnet' ? 'mainnet' : 'mock',
    requesterAddress: resolvedAddress || getRequesterAddress(options.wallet),
    stateDirectory: options.stateDirectory,
    privateKey: resolvedKey || getPrivateKey(options.wallet),
    rpcUrl,
  });

  const deadline = calculateDeadline(options.deadline, options.timeout);
  const startTime = Date.now();

  try {
    const requesterAddress = resolvedAddress || getRequesterAddress(options.wallet);
    // Convert budget to USDC wei (6 decimals) using string math to avoid float precision loss
    const budgetStr = String(options.budget);
    const parts = budgetStr.split('.');
    const whole = BigInt(parts[0]) * 1_000_000n;
    const decimal = parts[1] ? BigInt(parts[1].slice(0, 6).padEnd(6, '0')) : 0n;
    const amountWei = (whole + decimal).toString();

    // In mock mode, ensure requester has enough funds
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

    // PRD §5.6: put the bytes32 routing key on-chain, not JSON metadata.
    //
    // Pre-4.0.0 this site passed JSON.stringify({ service, input, timestamp }).
    // BlockchainRuntime.validateServiceHash then hashed the whole JSON string,
    // so the on-chain serviceHash was keccak256(JSON) — which never matched
    // `agent.provide(serviceName)` and routing failed silently on real chains.
    //
    // Also: `options.input` is dropped for 4.0.0. The handler will see
    // `job.input = {}`. The forthcoming `agirails.request.v1` envelope on
    // NegotiationChannel is the future path for requester→provider payloads
    // (PRD §11). Until then, callers needing input transport must use the
    // legacy SDK ≤ 3.5.3 directly or wait for the envelope release.
    if (options.input !== undefined && options.input !== null) {
      logger.warn(
        'options.input is not transported in 4.0.0 — handler will receive job.input = {}. ' +
        'A future agirails.request.v1 envelope will restore this path. See PRD §11.'
      );
    }
    const serviceHash = ethers.keccak256(ethers.toUtf8Bytes(validatedService));

    // Route through StandardAdapter so AA-enabled requesters use the
    // SmartWalletRouter (Paymaster-sponsored UserOps). Going through
    // `client.runtime` directly would force-sign with the raw EOA, which
    // holds no ETH under the AGIRAILS gasless model. Mock + EOA modes
    // fall through to runtime.createTransaction inside the adapter, so
    // behaviour is preserved. `requester` is derived from
    // `this.requesterAddress` inside the adapter; `amount` is the
    // human-readable budget (parseAmount handles unit conversion).
    const txId = await client.standard.createTransaction({
      provider,
      amount: options.budget,
      deadline,
      disputeWindow: options.disputeWindow ?? 172800,
      serviceDescription: serviceHash,
    });

    // linkEscrow → COMMITTED. ACTPKernel.linkEscrow requires
    // `msg.sender == txn.requester` ("Only requester" — kernel
    // ACTPKernel.sol:328), so the requester (us) must drive this on
    // testnet / mainnet. Pre-4.0.0-beta.3 this step was missing and the
    // tx stayed INITIATED indefinitely. Mock-mode providers still link
    // escrow on their side (the mock runtime has no requester check), so
    // we skip this step there to preserve existing test fixtures.
    if (options.network === 'testnet' || options.network === 'mainnet') {
      await client.standard.linkEscrow(txId);
    }

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

    if (!tx || (tx.state !== 'DELIVERED' && tx.state !== 'SETTLED')) {
      // Auto-cancel on timeout if still in early state
      if (tx && (tx.state === 'INITIATED' || tx.state === 'COMMITTED')) {
        try {
          logger.warn('Transaction timed out, cancelling to release funds', {
            txId,
            state: tx.state,
          });

          if ('cancelTransaction' in client.runtime) {
            await (client.runtime as any).cancelTransaction(txId);
            logger.info('Transaction cancelled successfully', { txId });

            const error = new TimeoutError(maxWaitTime, `Transaction cancelled after timeout`);
            (error as any).txId = txId;
            (error as any).wasCancelled = true;
            throw error;
          } else {
            // Route through StandardAdapter for AA-aware cancel; falls
            // through to runtime.transitionState on EOA/mock paths.
            await client.standard.transitionState(txId, 'CANCELLED');
            logger.info('Transaction cancelled successfully (via transitionState)', { txId });

            const error = new TimeoutError(maxWaitTime, `Transaction cancelled after timeout`);
            (error as any).txId = txId;
            (error as any).wasCancelled = true;
            throw error;
          }
        } catch (cancelError) {
          logger.error('Failed to cancel timed-out transaction', { txId }, cancelError as Error);
        }
      }

      const error = new TimeoutError(maxWaitTime, `waiting for service '${validatedService}' delivery`);
      (error as any).txId = txId;
      (error as any).currentState = tx?.state || 'UNKNOWN';
      throw error;
    }

    let deliveredResult: any = {};
    if (tx.deliveryProof) {
      const DELIVERY_PROOF_SCHEMA: Record<string, string> = {
        result: 'any',
        data: 'any',
        metadata: 'object',
        proof: 'string',
        timestamp: 'number',
        contentHash: 'string',
        txId: 'string',
        type: 'string',
      };

      const parsed = safeJSONParse(tx.deliveryProof, DELIVERY_PROOF_SCHEMA);

      if (parsed !== null) {
        deliveredResult = parsed;
      } else {
        deliveredResult = { data: tx.deliveryProof };
        logger.warn('Failed to parse delivery proof as JSON', { txId });
      }
    } else if (options.network === 'testnet' || options.network === 'mainnet') {
      logger.warn(
        'Delivery proof retrieval not yet implemented for testnet/mainnet. ' +
        'Result may be empty. Use ACTPClient with manual proof handling for production.',
        { txId, network: options.network }
      );
    }

    if (tx.state === 'DELIVERED' && tx.escrowId) {
      const disputeWindowEnd = computeDisputeWindowEnds(tx.completedAt ?? 0, tx.disputeWindow);
      const currentTime = client.runtime.time.now();

      if (currentTime >= disputeWindowEnd) {
        const isMockMode = options.network !== 'testnet' && options.network !== 'mainnet';

        if (isMockMode) {
          try {
            // Use StandardAdapter for consistency with the rest of the
            // request flow; mock falls through to runtime.releaseEscrow.
            await client.standard.releaseEscrow(tx.escrowId);
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
 * Resolve private key from keystore if wallet is auto/undefined and network is testnet/mainnet.
 * Returns undefined if wallet is explicitly set (caller should use getPrivateKey instead).
 */
async function resolveKeyIfNeeded(
  wallet?: 'auto' | 'connect' | string | { privateKey: string },
  network?: string,
  stateDirectory?: string
): Promise<string | undefined> {
  if (wallet && wallet !== 'auto') return undefined; // explicit wallet, skip auto-detect
  if (network !== 'testnet' && network !== 'mainnet') return undefined;
  return resolvePrivateKey(stateDirectory, { network });
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
  // If specific provider specified, normalize and use it
  if (providerOption && providerOption !== 'any' && providerOption !== 'best' && providerOption !== 'cheapest') {
    if (!isValidAddress(providerOption)) {
      throw new ValidationError('provider', `Invalid provider address: "${providerOption}". Must be a valid Ethereum address.`);
    }
    return ethers.getAddress(providerOption);
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

function getRequesterAddress(
  wallet?: 'auto' | 'connect' | string | { privateKey: string }
): string {
  if (!wallet || wallet === 'auto') {
    const hex = Buffer.from('requester').toString('hex');
    return '0x' + hex.padEnd(40, '0');
  }

  if (wallet === 'connect') {
    throw new Error('Browser wallet connection not yet implemented');
  }

  if (typeof wallet === 'string') {
    if (!isValidAddress(wallet)) {
      throw new ValidationError('wallet', `Invalid Ethereum address format: ${wallet}`);
    }
    return ethers.getAddress(wallet);
  }

  try {
    const walletInstance = new ethers.Wallet(wallet.privateKey);
    return ethers.getAddress(walletInstance.address);
  } catch (error) {
    throw new ValidationError('wallet.privateKey', 'Invalid private key format');
  }
}

function getPrivateKey(
  wallet?: 'auto' | 'connect' | string | { privateKey: string }
): string | undefined {
  if (!wallet || wallet === 'auto' || wallet === 'connect') {
    return undefined;
  }

  if (typeof wallet === 'string') {
    if (/^0x[0-9a-fA-F]{64}$/.test(wallet)) {
      try {
        new ethers.Wallet(wallet);
        return wallet;
      } catch {
        throw new ValidationError('wallet', 'Invalid private key format');
      }
    }
    return undefined;
  }

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
