import { Wallet, TypedDataEncoder, verifyTypedData, ZeroHash } from 'ethers';
import { EvaluatorClient } from './EvaluatorClient';
import { type EvidenceBundle } from './EvidenceBundle';
import { receiptAuthorizationTypedData, authorizePaymentReceipt, postPaidEvaluation } from './ReceiptAuthorization';
import { kernelCreationInterface, kernelCreationArguments } from '../protocol/kernelCreation';
import { buildACTPPayBatch } from '../wallet/aa/TransactionBatcher';
import { decodeResolutionProof } from './CompositeMediator';
import { DisputeSplitIndexer } from '../reputation/DisputeSplitIndexer';
import { AbiCoder } from 'ethers';

const wallet = new Wallet('0x' + '01'.repeat(32));
const input = { chainId: 84532, verifyingContract: '0x' + '33'.repeat(20), quoteHash: '0x' + '44'.repeat(32), disputeNonce: 'dn_non_bytes32', txHash: '0x' + '55'.repeat(32), payer: wallet.address };
const bundle: EvidenceBundle = { schemaVersion: '1.0.0', disputeId: '0x' + '11'.repeat(32),
  spec: { agirailsMdCID: 'bafySpec', capabilities: ['summarize'], slaHash: '0x' + '11'.repeat(32) },
  delivery: { deliverableHash: '0x' + '22'.repeat(32), deliverableCID: 'bafyDelivery', retrievalInstructions: 'ipfs get', deliveredAt: 1700000000 },
  dispute: { reason: 'too short', evidenceCID: 'bafyEvidence', openedAt: 1700000100 },
  timeline: [{ event: 'DELIVERED', at: 1700000000 }, { event: 'DISPUTED', at: 1700000100 }],
  reasoning: { evaluatorPromptCID: 'bafyPrompt', modelVersions: ['a', 'b'], notes: '' } };

it.each([{ quote: { chainId: 8453 } }, { x402: { chainId: 8453 } }, { x402: { network: 'eip155:8453' } }])('rejects foreign payment chain before public client pay', async foreign => {
  const pay = jest.fn(async () => ({ response: new Response('{}') }));
  const client = new EvaluatorClient({ baseUrl: 'https://synthetic.example', paymentClient: { pay },
    fetchImpl: async () => new Response(JSON.stringify({ disputeNonce: 'dn', quote: { chainId: 84532, amount: '1' }, ...foreign }), { status: 402 }) });
  await expect(client.requestEvaluation({ bundle, disputeId: bundle.disputeId, payer: wallet.address, chainId: 84532,
    verifyingContract: input.verifyingContract, escrowAmount: '5000000', tier: 0, bundleSource: {}, fixedEvaluators: [], rotatingPool: [] })).rejects.toThrow(/conflicts/);
  expect(pay).not.toHaveBeenCalled();
});

it('signs receipt authorization with the payer and transports it without claiming ruling verification', async () => {
  const receipt = await authorizePaymentReceipt({ scheme: 'exact', network: 'eip155:84532', txHash: input.txHash, payload: '{}' }, input, {
    getAddress: () => wallet.address, signTypedData: async typed => wallet.signTypedData(typed.domain, typed.types, typed.message),
  });
  const data = receiptAuthorizationTypedData(input);
  expect(verifyTypedData(data.domain, data.types, data.message, receipt.authorization.signature)).toBe(wallet.address);
  expect(TypedDataEncoder.hash(data.domain, data.types, data.message)).toMatch(/^0x[0-9a-f]{64}$/);
  const fetcher = jest.fn(async (_url: unknown, init?: { body?: unknown; redirect?: unknown }) => {
    expect(JSON.parse(String(init?.body)).receipt.authorization).toEqual(receipt.authorization);
    expect(init?.redirect).toBe('error'); return new Response('{}', { status: 402 });
  });
  expect((await postPaidEvaluation('https://synthetic.example', { receipt }, fetcher)).status).toBe(402);
});

it('keeps both local deployment encodings and refuses to erase agreementHash on legacy', () => {
  const legacy = '0x048c811352e8a3fECd5b0Ec4AA2c2b94083CC842';
  const args = [wallet.address, wallet.address, 100000n, 999999n, 3600n, ZeroHash, ZeroHash, 42n, 43n];
  const oldInterface = kernelCreationInterface(legacy), nextInterface = kernelCreationInterface('0x' + '66'.repeat(20));
  expect(oldInterface.getFunction('createTransaction')?.inputs).toHaveLength(8);
  expect(nextInterface.getFunction('createTransaction')?.inputs).toHaveLength(9);
  const batch = buildACTPPayBatch({ provider: wallet.address, requester: wallet.address, amount: '100000', deadline: 999999, disputeWindow: 3600,
    serviceHash: ZeroHash, agentId: '42', requesterAgentId: '43', actpNonce: 0n, contracts: { actpKernel: legacy, escrowVault: input.verifyingContract, usdc: '0x' + '77'.repeat(20) } });
  const call = batch.calls[1]; if (!call) throw new Error('Missing creation call');
  const decoded = oldInterface.decodeFunctionData('createTransaction', call.data);
  expect(decoded[6]).toBe(42n); expect(decoded[7]).toBe(43n);
  expect(() => kernelCreationArguments(legacy, args, input.quoteHash)).toThrow(/refusing to discard/);
  const event = oldInterface.encodeEventLog('TransactionCreated', [ZeroHash, wallet.address, wallet.address, 1, ZeroHash, 2, 1, 42]);
  expect(oldInterface.parseLog(event)?.name).toBe('TransactionCreated');
});

it('uses explicit principal instead of raw fee-only balance for proof classification', () => {
  const proof = AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256', 'bool'], [1, 0, true]);
  const result = new DisputeSplitIndexer().classifyPayout({ provider: wallet.address, requester: wallet.address,
    kind: 'settled', remaining: 50000n, escrowPrincipal: 0n, proof });
  expect(result?.phantomSentinel).toBe(true);
  expect(result?.payouts).toEqual({ requester: 0n, provider: 0n });
  expect(decodeResolutionProof(proof, 50000n).payouts.requester).toBe(1n);
  expect(decodeResolutionProof(proof, 50000n, 0n).phantomSentinel).toBe(true);
});

it('legacy automatic client rejects signed-receipt capability before paying', async () => {
  const pay = jest.fn(async () => ({ response: new Response('{}') }));
  const client = new EvaluatorClient({ baseUrl: 'https://synthetic.example', paymentClient: { pay }, fetchImpl: async () =>
    new Response(JSON.stringify({ disputeNonce: 'dn', x402: { receiptAuthorization: { version: '1' } } }), { status: 402 }) });
  await expect(client.requestEvaluation({ bundle, disputeId: bundle.disputeId, payer: wallet.address, chainId: 84532,
    verifyingContract: input.verifyingContract, escrowAmount: '5000000', tier: 0, bundleSource: {}, fixedEvaluators: [], rotatingPool: [] })).rejects.toThrow(/signed paid receipts/);
  expect(pay).not.toHaveBeenCalled();
});
