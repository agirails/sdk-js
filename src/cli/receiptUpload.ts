/**
 * Upload a settled receipt to the agirails.app public receipt endpoint.
 *
 * Auth:
 *   - Mock network: API key required (AGIRAILS_API_KEY).
 *   - On-chain (testnet/mainnet): API key OR EIP-712 wallet signature.
 *     Wallet path is preferred since the agent already has a signer available.
 *
 * Failure mode: best-effort. A network error never fails the settlement flow.
 * The receipt's canonical source of truth is the kernel's on-chain log; the
 * web receipt is a cosmetic, shareable artifact.
 *
 * @module cli/receiptUpload
 */

import { ethers } from 'ethers';

// ============================================================================
// Types
// ============================================================================

export interface ReceiptUploadPayload {
  agentAddress: string;
  service: string;
  serviceHash?: string;
  amountWei: string;
  feeWei: string;
  netWei: string;
  txId: string;                    // ACTP bytes32
  kernelAddress?: string;          // required for on-chain
  ethTxHash?: string;
  logIndex?: number;
  blockNumber?: number;
  network: 'mock' | 'base-sepolia' | 'base-mainnet';
  requesterAddress: string;
  durationMs: number;
  ownerCaption?: string;
}

export interface ReceiptUploadOptions {
  /** Base URL for the receipt API. Defaults to https://agirails.app */
  baseUrl?: string;
  /** Optional wallet for EIP-712 wallet-sig auth. Required for on-chain without API key. */
  signer?: ethers.Wallet | ethers.HDNodeWallet;
  /** Optional API key for mock or on-chain. */
  apiKey?: string;
}

export interface ReceiptUploadResult {
  ok: true;
  id: string;
  url: string;
  milestone: string | null;
}

export interface ReceiptUploadFailure {
  ok: false;
  reason: string;
}

// ============================================================================
// Public API
// ============================================================================

const DEFAULT_BASE_URL = process.env.AGIRAILS_BASE_URL ?? 'https://agirails.app';
const EIP712_DOMAIN_NAME = 'AGIRAILS Receipts';
const EIP712_DOMAIN_VERSION = '1';

function chainIdFor(network: string): number {
  if (network === 'base-mainnet') return 8453;
  if (network === 'base-sepolia') return 84532;
  throw new Error(`No chain ID for network: ${network}`);
}

export async function uploadReceipt(
  payload: ReceiptUploadPayload,
  options: ReceiptUploadOptions = {},
): Promise<ReceiptUploadResult | ReceiptUploadFailure> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const endpoint =
    payload.network === 'mock'
      ? `${baseUrl}/api/v1/receipts/mock`
      : `${baseUrl}/api/v1/receipts`;

  const apiKey = options.apiKey ?? process.env.AGIRAILS_API_KEY;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  let body: Record<string, unknown> = { ...payload };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  } else if (payload.network !== 'mock' && options.signer) {
    // Wallet-sig auth path: sign EIP-712 ReceiptWrite over a minimal commitment.
    const nonce = ethers.hexlify(ethers.randomBytes(16));
    const issuedAt = Math.floor(Date.now() / 1000);
    const domain = {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: chainIdFor(payload.network),
    };
    const types = {
      ReceiptWrite: [
        { name: 'agentAddress', type: 'address' },
        { name: 'txId', type: 'bytes32' },
        { name: 'network', type: 'string' },
        { name: 'amountWei', type: 'string' },
        { name: 'netWei', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
      ],
    };
    const signable = {
      agentAddress: payload.agentAddress,
      txId: payload.txId,
      network: payload.network,
      amountWei: payload.amountWei,
      netWei: payload.netWei,
      nonce,
      issuedAt,
    };
    const signature = await options.signer.signTypedData(domain, types, signable);
    headers['x-agent-address'] = payload.agentAddress;
    headers['x-agent-signature'] = signature;
    body = { ...body, nonce, issuedAt };
  } else {
    return { ok: false, reason: 'No credentials: set AGIRAILS_API_KEY or pass a signer' };
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let errText = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) errText = j.error;
      } catch {
        /* ignore */
      }
      return { ok: false, reason: errText };
    }
    const json = (await res.json()) as { id: string; url: string; milestone: string | null };
    return {
      ok: true,
      id: json.id,
      url: json.url.startsWith('http') ? json.url : `${baseUrl}${json.url}`,
      milestone: json.milestone,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'network error';
    return { ok: false, reason: msg };
  }
}
