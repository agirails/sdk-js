import { getAddress, isHexString } from 'ethers';
import type { EIP712TypedData } from '../types/eip712';

export interface ReceiptAuthorizationInput {
  chainId: number;
  verifyingContract: string;
  quoteHash: string;
  disputeNonce: string;
  txHash: string;
  payer: string;
}

/** Quote-bound authorization, independent of EIP-3009 or Permit2 payment mode. */
export function receiptAuthorizationTypedData(input: ReceiptAuthorizationInput): EIP712TypedData {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error('Invalid receipt authorization chainId');
  if (!isHexString(input.quoteHash, 32) || !isHexString(input.txHash, 32)) throw new Error('Invalid receipt authorization hash');
  if (!input.disputeNonce || input.disputeNonce.length > 1024) throw new Error('Invalid receipt authorization nonce');
  return {
    domain: { name: 'AGIRAILS Evaluator Receipt', version: '1', chainId: input.chainId, verifyingContract: getAddress(input.verifyingContract) },
    primaryType: 'ReceiptAuthorization',
    types: { ReceiptAuthorization: [
      { name: 'quoteHash', type: 'bytes32' }, { name: 'disputeNonce', type: 'string' },
      { name: 'txHash', type: 'bytes32' }, { name: 'payer', type: 'address' },
    ] },
    message: { quoteHash: input.quoteHash, disputeNonce: input.disputeNonce, txHash: input.txHash, payer: getAddress(input.payer) },
  };
}

export interface ReceiptAuthorizer {
  getAddress(): string;
  signTypedData?(data: EIP712TypedData): Promise<string>;
}

export interface AuthorizedPaymentReceipt {
  scheme: string;
  network: string;
  txHash: string;
  payload: string;
  authorization: { version: '1'; signature: string };
}

/** Sign a settled payment's exact quote. Does not pay or deploy a wallet. */
export async function authorizePaymentReceipt(
  receipt: Omit<AuthorizedPaymentReceipt, 'authorization'>,
  input: ReceiptAuthorizationInput,
  signer: ReceiptAuthorizer
): Promise<AuthorizedPaymentReceipt> {
  if (getAddress(signer.getAddress()) !== getAddress(input.payer)) throw new Error('Receipt authorizer is not payer');
  if (receipt.txHash.toLowerCase() !== input.txHash.toLowerCase()) throw new Error('Receipt authorization txHash mismatch');
  if (!signer.signTypedData) throw new Error('Wallet cannot authorize evaluator receipts');
  const signature = await signer.signTypedData(receiptAuthorizationTypedData(input));
  if (!isHexString(signature) || signature.length < 4) throw new Error('Invalid receipt authorization signature');
  if (signature.toLowerCase().endsWith('6492'.repeat(16))) throw new Error('Counterfactual ERC-6492 receipt signatures are unsupported; deploy the wallet first');
  return { ...receipt, authorization: { version: '1', signature } };
}

/** Explicit paid-receipt HTTP transport. The returned response is unverified;
 * this function does not verify v2 ruling signatures or settle a payment.
 */
export async function postPaidEvaluation(
  baseUrl: string,
  body: Record<string, unknown> & { receipt: AuthorizedPaymentReceipt },
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error('Paid evaluation requires HTTPS or a loopback test server');
  }
  return fetchImpl(baseUrl.replace(/\/+$/, '') + '/evaluate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error',
  });
}
