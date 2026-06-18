/**
 * Buyer-visible settlement receipt — SDK push path.
 *
 * On SETTLED state transition, the SDK posts a V2-signed receipt to the
 * AGIRAILS Platform. The response includes a clickable receipt URL which the
 * CLI prints to the terminal — the wow moment.
 *
 * Integration points (sdk-js team):
 *   1. Import this module from wherever lifecycle reaches SETTLED
 *      (likely src/api/level1/Agent.ts or src/runtime/BlockchainRuntime.ts).
 *   2. After the on-chain state advances to SETTLED, call:
 *        const { receiptUrl } = await pushReceiptOnSettled({...});
 *   3. Surface receiptUrl on the public RequestResult and to CLI commands
 *      (pay, test, serve) so they print it.
 *
 * Non-goals:
 *   - This module does NOT change the lifecycle itself.
 *   - Failure is non-fatal: settlement already happened on-chain; the Platform
 *     indexer cron is the backstop for cases where this POST fails.
 *
 * Auth: V2 EIP-712 signature, requester wallet (when SDK acts as requester) or
 *   provider wallet (when SDK acts as provider). The Platform's POST handler
 *   verifies the signer matches participantRole, AND independently verifies
 *   on-chain that the tx really exists with claimed values. Forgery is not
 *   possible without on-chain truth.
 */

import { ethers, type Signer, type TypedDataField } from "ethers";

// ──────────────────────────────────────────────────────────────────────────
// EIP-712 V2 — must match Platform/agirails.app/web/lib/receipts/eip712.ts
// ──────────────────────────────────────────────────────────────────────────

export const RECEIPT_WRITE_DOMAIN_V2 = {
  name: "AGIRAILS Receipts",
  version: "2",
};

export const RECEIPT_WRITE_TYPES_V2: Record<string, TypedDataField[]> = {
  ReceiptWriteV2: [
    { name: "signerAddress", type: "address" },
    { name: "participantRole", type: "string" },
    { name: "providerAddress", type: "address" },
    { name: "requesterAddress", type: "address" },
    { name: "kernelAddress", type: "address" },
    { name: "txId", type: "bytes32" },
    { name: "network", type: "string" },
    { name: "amountWei", type: "uint256" },
    { name: "feeWei", type: "uint256" },
    { name: "netWei", type: "uint256" },
    { name: "serviceHash", type: "bytes32" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "uint64" },
  ],
};

const ZERO_BYTES32 = "0x" + "0".repeat(64);

export type ParticipantRole = "provider" | "requester";

export type Network = "base-sepolia" | "base-mainnet";

function chainIdForNetwork(network: Network): number {
  return network === "base-mainnet" ? 8453 : 84532;
}

// ──────────────────────────────────────────────────────────────────────────
// pushReceiptOnSettled — fire-and-recover at lifecycle SETTLED
// ──────────────────────────────────────────────────────────────────────────

export interface PushReceiptArgs {
  /** Platform base URL — defaults to production. Override for staging tests. */
  apiBase?: string;
  /** Signer for this side — provider wallet (provider push) or requester wallet (requester push). */
  signer: Signer;
  /** Role the signer is claiming. Provider for earn pushes, requester for buyer pushes. */
  participantRole: ParticipantRole;
  /** On-chain participants. Same values that ACTPKernel.getTransaction returns. */
  providerAddress: string;
  requesterAddress: string;
  kernelAddress: string;
  txId: string;
  network: Network;
  amountWei: string;
  feeWei: string;
  netWei: string;
  /** Optional — zero bytes32 if not yet emitted by the service descriptor. */
  serviceHash?: string;
  /** Human-readable service slug (for receipt display). */
  service: string;
  /** Optional — when the SDK can compute it cheaply. Indexer fills in otherwise. */
  ethTxHash?: string;
  blockNumber?: number;
  logIndex?: number;
  /** Milliseconds from INITIATED to SETTLED (CLI lifecycle timer). */
  durationMs: number;
}

export interface PushReceiptResult {
  /** Absolute URL the CLI prints. null when POST failed (indexer is backstop). */
  receiptUrl: string | null;
  /** Receipt PK on the Platform, when known. */
  receiptId: string | null;
  /** True when the server confirmed on-chain match before minting. */
  verifiedOnChain: boolean;
  /**
   * Why the push failed, when it did (`post_failed:<status> <error>: <detail>`
   * or `prepare_failed:<status>`), else undefined. A missing-field 400 and an
   * on-chain 422 both surface as a null URL — without this, the reason is lost
   * and the two are indistinguishable to the caller.
   */
  reason?: string;
}

export async function pushReceiptOnSettled(args: PushReceiptArgs): Promise<PushReceiptResult> {
  // Resolution priority: explicit arg > AGIRAILS_BASE_URL env > prod default.
  // Matches the env-driven origin convention already used by cli/receiptUpload.ts.
  const apiBase = (
    args.apiBase ?? process.env.AGIRAILS_BASE_URL ?? "https://agirails.app"
  ).replace(/\/+$/, "");
  const signerAddress = await args.signer.getAddress();

  try {
    // 1) Fetch a single-use nonce bound to the signer wallet.
    const prepRes = await fetch(`${apiBase}/api/v1/receipts/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signerAddress }),
    });
    if (!prepRes.ok) throw new Error(`prepare_failed:${prepRes.status}`);
    const { nonce } = (await prepRes.json()) as { nonce: string };

    const issuedAt = Math.floor(Date.now() / 1000);
    const payload = {
      signerAddress,
      participantRole: args.participantRole,
      providerAddress: args.providerAddress,
      requesterAddress: args.requesterAddress,
      kernelAddress: args.kernelAddress,
      txId: args.txId,
      network: args.network,
      amountWei: args.amountWei,
      feeWei: args.feeWei,
      netWei: args.netWei,
      serviceHash: args.serviceHash ?? ZERO_BYTES32,
      nonce,
      issuedAt,
    };

    // 2) EIP-712 V2 sign — domain chainId is part of the binding.
    const domain = {
      ...RECEIPT_WRITE_DOMAIN_V2,
      chainId: chainIdForNetwork(args.network),
    };
    const signature = await args.signer.signTypedData(domain, RECEIPT_WRITE_TYPES_V2, payload);

    // 3) POST receipt. Body fields match the payload; server reconstructs
    //    and verifies them against the signature.
    const postRes = await fetch(`${apiBase}/api/v1/receipts`, {
      method: "POST",
      headers: {
        "X-Agent-Address": signerAddress,
        "X-Agent-Signature": signature,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        participantRole: args.participantRole,
        signerAddress,
        agentAddress: args.providerAddress,
        requesterAddress: args.requesterAddress,
        kernelAddress: args.kernelAddress,
        txId: args.txId,
        network: args.network,
        amountWei: args.amountWei,
        feeWei: args.feeWei,
        netWei: args.netWei,
        serviceHash: args.serviceHash,
        ethTxHash: args.ethTxHash,
        blockNumber: args.blockNumber,
        logIndex: args.logIndex,
        service: args.service,
        durationMs: args.durationMs,
        agentSignature: signature,
        agentSignatureAlgorithm: "EIP712-ReceiptV2",
        nonce,
        issuedAt,
      }),
    });

    if (!postRes.ok) {
      // Common failure modes documented for SDK error handler:
      //   400 — invalid/missing field in the POST body (SDK bug — e.g. an
      //         omitted durationMs; the body's `error` names the field)
      //   401 — signature / signer / nonce invalid (likely SDK bug)
      //   403 — role / address mismatch (SDK is signing as wrong wallet)
      //   404 — agent not registered (buyer-side fresh-wallet path; expected,
      //         caller should still log the txId for indexer fallback)
      //   422 — on_chain_verification_failed (RPC desync; transient — retry)
      //   429 — rate limited (back off)
      // Read the server's {error, detail} so the reason rides up on the thrown
      // Error instead of collapsing to a bare status code.
      const detail = await postRes
        .json()
        .then((b: { error?: string; detail?: string }) =>
          [b.error, b.detail].filter(Boolean).join(": "),
        )
        .catch(() => "");
      throw new Error(`post_failed:${postRes.status}${detail ? ` ${detail}` : ""}`);
    }
    const body = (await postRes.json()) as {
      id?: string;
      url?: string;
      verified_on_chain?: boolean;
    };

    return {
      receiptUrl: body.url ?? null,
      receiptId: body.id ?? null,
      verifiedOnChain: !!body.verified_on_chain,
    };
  } catch (err) {
    // Receipt POST failure is non-fatal — settlement already happened on-chain,
    // and the indexer cron at /api/cron/index-stats backfills rows within ~5min.
    // But DON'T swallow the reason: a 400 (missing field) and a 422 (RPC desync)
    // both surface as a null URL, and conflating them has cost real debug time.
    // Carry it on `reason` and warn so callers/operators can see WHY it failed.
    const reason = err instanceof Error ? err.message : String(err);
    if (typeof console !== "undefined" && console.warn) {
      console.warn(`[receipts] push failed (non-fatal): ${reason}`);
    }
    return { receiptUrl: null, receiptId: null, verifiedOnChain: false, reason };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CLI helper — what to print at SETTLED
// ──────────────────────────────────────────────────────────────────────────

export interface FormatSettledLineArgs {
  participantRole: ParticipantRole;
  /** Net to provider (their earnings) — already formatted (e.g. "$4.95"). */
  netDisplay: string;
  /** Gross from requester (what they paid) — already formatted. */
  grossDisplay: string;
  /** Counterparty slug or short address. */
  counterpartyDisplay: string;
  /** Result from pushReceiptOnSettled. */
  receiptUrl: string | null;
}

/**
 * Format the one-line CLI summary the buyer or provider sees at SETTLED.
 * Returns the line as a string; the CLI prints it. URL is omitted if null
 * (indexer backstop will eventually mint a receipt but we have no PK for it).
 */
export function formatSettledLine(args: FormatSettledLineArgs): string {
  const action = args.participantRole === "provider"
    ? `Earned ${args.netDisplay} from ${args.counterpartyDisplay}`
    : `Paid ${args.grossDisplay} to ${args.counterpartyDisplay}`;
  if (args.receiptUrl) {
    return `[SETTLED] ${action}\n           Receipt: ${args.receiptUrl}`;
  }
  return `[SETTLED] ${action}`;
}
