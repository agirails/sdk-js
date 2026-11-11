import { FeeSplitChain, FeeSplitChainProvider } from '../__tests__/helpers/feeSplitChain';
import { ChainFeeSplitReader } from './ChainFeeSplitReader';

const TX = '0x' + 'a7'.repeat(32);
const INTEGRATOR = '0x00000000000000000000000000000000000000d0';
const RAW_REMAINING = 752_497_500n;
const PRINCIPAL = 750_000_000n;

describe('dispute-fee disclosure read from the chain', () => {
  let chain: FeeSplitChain;
  let reader: ChainFeeSplitReader;

  beforeEach(() => {
    chain = new FeeSplitChain();
    chain.locked.set(TX, { integrator: INTEGRATOR, bps: 100, profile: 1 });
    chain.principals.set(TX, PRINCIPAL);
    reader = new ChainFeeSplitReader(new FeeSplitChainProvider(chain), chain.kernel);
  });

  it('FSV-V7-001: the amount is the kernel principal, 735 / 7.5 / 7.5, never the raw vault remaining', async () => {
    const quote = await reader.quoteRefundIfDisputed(chain.vault, TX);
    expect(quote).toEqual({
      refundAmount: '750000000',
      requesterAmount: '735000000',
      protocolFee: '7500000',
      integratorFee: '7500000',
      rateConfirmed: true,
    });
    const fromRawRemaining = RAW_REMAINING - (RAW_REMAINING * 100n) / 10_000n - (RAW_REMAINING * 100n) / 10_000n;
    expect(fromRawRemaining).toBe(737_447_550n);
    expect(quote.requesterAmount).not.toBe(fromRawRemaining.toString());
    expect(chain.reads.map(read => read.name)).toEqual(['escrowPrincipal', 'quoteRefundIfDisputed']);
  });

  it('reads the principal and the quote at one block', async () => {
    await reader.quoteRefundIfDisputed(chain.vault, TX);
    const tags = chain.reads.map(read => read.blockTag);
    expect(tags).toEqual(['0x64', '0x64']);
  });

  it('the actual quote is fee-free until the escrow is disputed', async () => {
    expect(await reader.quoteRefund(chain.vault, TX, PRINCIPAL)).toMatchObject({
      requesterAmount: '750000000',
      protocolFee: '0',
      integratorFee: '0',
    });
    chain.disputed.add(TX);
    expect(await reader.quoteRefund(chain.vault, TX, PRINCIPAL)).toMatchObject({
      requesterAmount: '735000000',
      protocolFee: '7500000',
      integratorFee: '7500000',
    });
  });

  it('profile PAYOUT_ONLY: the hypothetical quote carries no fee', async () => {
    chain.locked.set(TX, { integrator: INTEGRATOR, bps: 100, profile: 0 });
    expect(await reader.quoteRefundIfDisputed(chain.vault, TX)).toMatchObject({
      requesterAmount: '750000000',
      protocolFee: '0',
      integratorFee: '0',
    });
  });
});
