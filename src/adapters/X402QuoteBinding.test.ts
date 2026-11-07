import { EvaluatorClient } from '../dispute/EvaluatorClient';
import { X402Adapter } from './X402Adapter';
import { X402QuoteMismatchError } from '../errors/X402Errors';
import type { IWalletProvider } from '../wallet/IWalletProvider';

const asset = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const payTo = '0x' + '22'.repeat(20);
const quote = { amount: '250000', asset, payTo, network: 'eip155:84532' };
function wallet() {
  const sign = jest.fn().mockResolvedValue('0x' + 'ab'.repeat(65));
  return { sign, provider: { getAddress: () => '0x' + '11'.repeat(20), signTypedData: sign, getWalletInfo: () => ({ tier: 'eoa' }) } as unknown as IWalletProvider };
}
function challenge(amount = quote.amount, recipient = payTo): Response {
  const required = { x402Version: 2, resource: { url: 'https://ev.example/evaluate', description: 'test', mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: 'eip155:84532', asset, payTo: recipient, amount, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }] };
  return new Response('{}', { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(required)).toString('base64') } });
}

describe('accepted quote across real x402 selection', () => {
  it.each(['base', 'base-sepolia', 'eip155:84532'])('normalizes evaluator network %s using its chainId', async network => {
    const ec = new EvaluatorClient({ baseUrl: 'https://ev.example', paymentClient: { pay: async () => ({}) } as never });
    const body = { quote: { amount: '250000', asset, chainId: 84532 }, disputeNonce: 'n1', x402: { network, payTo } };
    const bound = (ec as unknown as { buildAcceptedQuote(q: unknown, chainId: number): typeof quote }).buildAcceptedQuote(body, 84532);
    expect(bound.network).toBe('eip155:84532');
    const w = wallet(); let attempts = 0;
    const fetchImpl = (async () => { attempts++; return challenge(); }) as typeof fetch;
    const adapter = new X402Adapter({ walletProvider: w.provider, fetchImpl });
    // Correct quote reaches signing. The fixture never settles: only this boundary is asserted.
    await adapter.pay({ to: 'https://ev.example/evaluate', metadata: { paymentMethod: 'x402' }, acceptedQuote: bound }).catch(() => undefined);
    expect(w.sign).toHaveBeenCalledTimes(1); expect(attempts).toBeGreaterThanOrEqual(1);
  });
  it('rejects contradictory CAIP-2 and chainId before payment', () => {
    const ec = new EvaluatorClient({ baseUrl: 'https://ev.example', paymentClient: { pay: async () => ({}) } as never });
    expect(() => (ec as unknown as { buildAcceptedQuote(q: unknown, chainId: number): unknown }).buildAcceptedQuote({ quote: { amount: '1', chainId: 84532 }, x402: { network: 'eip155:8453' } }, 84532)).toThrow(/conflicts/);
  });
  it('overlapping unquoted payment cannot remove the first payment quote guard', async () => {
    const w = wallet(); let release!: () => void; const secondDone = new Promise<void>(r => { release = r; });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'object' && 'url' in input ? String(input.url) : String(input);
      if (url.endsWith('/evaluate')) { await secondDone; return challenge('900000', '0x' + '99'.repeat(20)); }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const adapter = new X402Adapter({ walletProvider: w.provider, fetchImpl });
    const first = adapter.pay({ to: 'https://ev.example/evaluate', metadata: { paymentMethod: 'x402' }, acceptedQuote: quote });
    const rejection = expect(first).rejects.toBeInstanceOf(X402QuoteMismatchError);
    await adapter.pay({ to: 'https://other.example/item', metadata: { paymentMethod: 'x402' } }).catch(() => undefined);
    release(); await rejection; expect(w.sign).not.toHaveBeenCalled();
  });
});
