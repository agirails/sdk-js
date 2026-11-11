import { joinPayoutBreakdown, type KernelPayout, type VaultSplit } from './breakdown';
import { breakdownSummary, verifiedAmounts } from './display';

const USDC = 1_000_000n;
const K = 1000n * USDC;
const TX = '0x' + 'ab'.repeat(32);
const VAULT = '0x00000000000000000000000000000000000000aa';

function released(kernelAmount: bigint, received: bigint, integratorAmount: bigint, credited = false): VaultSplit {
  return {
    kind: 'released',
    kernelAmount,
    received,
    integratorAmount,
    integratorCredited: credited,
    protocolFee: 0n,
    protocolCredited: false,
  };
}

function refunded(
  kernelAmount: bigint,
  received: bigint,
  protocolFee: bigint,
  integratorAmount: bigint,
  credited: { protocol?: boolean; integrator?: boolean } = {}
): VaultSplit {
  return {
    kind: 'refunded',
    kernelAmount,
    received,
    integratorAmount,
    integratorCredited: credited.integrator === true,
    protocolFee,
    protocolCredited: credited.protocol === true,
  };
}

function join(deposit: bigint, kernel: KernelPayout[], splits: VaultSplit[], principal = 0n) {
  return joinPayoutBreakdown({ txId: TX, vault: VAULT, deposit, principal, kernel, splits });
}

const usdc = (wei: string): string => (Number(wei) / 1_000_000).toFixed(2);

describe('payout breakdown: kernel events joined with vault fee splits', () => {
  it('A3: settle', () => {
    const b = join(K, [{ kind: 'released', amount: 990n * USDC }], [released(990n * USDC, 980n * USDC, 10n * USDC)]);
    expect(b.totals).toEqual({
      providerReceived: '980000000',
      requesterReceived: '0',
      mediatorReceived: '0',
      kernelFee: '10000000',
      vaultProtocolFee: '0',
      integratorPaid: '10000000',
      integratorCredited: '0',
      protocolCredited: '0',
    });
    expect(breakdownSummary(verifiedAmounts(b), K.toString(), usdc)).toBe(
      '980.00 USDC to provider (1000.00 committed, 10.00 protocol fee, 10.00 platform fee)'
    );
  });

  it('A4: milestones 250 / 250 / 500, one movement each', () => {
    const b = join(
      K,
      [
        { kind: 'released', amount: 247_500_000n },
        { kind: 'released', amount: 247_500_000n },
        { kind: 'released', amount: 495n * USDC },
      ],
      [
        released(247_500_000n, 245n * USDC, 2_500_000n),
        released(247_500_000n, 245n * USDC, 2_500_000n),
        released(495n * USDC, 490n * USDC, 5n * USDC),
      ]
    );
    expect(b.movements.map(m => m.integratorPaid)).toEqual(['2500000', '2500000', '5000000']);
    expect(b.totals.providerReceived).toBe('980000000');
    expect(b.totals.integratorPaid).toBe('10000000');
    expect(b.totals.kernelFee).toBe('10000000');
  });

  it('A7 (D): split 600 / 400, the refund is untouched', () => {
    const b = join(
      K,
      [
        { kind: 'released', amount: 396n * USDC },
        { kind: 'refunded', amount: 600n * USDC },
      ],
      [released(396n * USDC, 392n * USDC, 4n * USDC)]
    );
    expect(b.totals).toMatchObject({
      providerReceived: '392000000',
      requesterReceived: '600000000',
      kernelFee: '4000000',
      vaultProtocolFee: '0',
      integratorPaid: '4000000',
    });
    expect(breakdownSummary(verifiedAmounts(b), K.toString(), usdc)).toBe(
      '392.00 USDC to provider (1000.00 committed, 4.00 protocol fee, 4.00 platform fee); ' +
        'refunded 600.00, received 600.00, protocol 0.00, platform 0.00'
    );
  });

  it('A7 (B): the refund pays 6 protocol and 6 platform', () => {
    const b = join(
      K,
      [
        { kind: 'released', amount: 396n * USDC },
        { kind: 'refunded', amount: 600n * USDC },
      ],
      [released(396n * USDC, 392n * USDC, 4n * USDC), refunded(600n * USDC, 588n * USDC, 6n * USDC, 6n * USDC)]
    );
    expect(b.totals).toMatchObject({
      providerReceived: '392000000',
      requesterReceived: '588000000',
      kernelFee: '4000000',
      vaultProtocolFee: '6000000',
      integratorPaid: '10000000',
    });
    expect(breakdownSummary(verifiedAmounts(b), K.toString(), usdc)).toBe(
      '392.00 USDC to provider (1000.00 committed, 4.00 protocol fee, 4.00 platform fee); ' +
        'refunded 600.00, received 588.00, protocol 6.00, platform 6.00'
    );
  });

  it('A9 (D): requester wins, full refund', () => {
    const b = join(K, [{ kind: 'refunded', amount: K }], []);
    expect(b.totals).toMatchObject({ requesterReceived: '1000000000', kernelFee: '0', vaultProtocolFee: '0' });
    expect(breakdownSummary(verifiedAmounts(b), K.toString(), usdc)).toBe(
      'refunded 1000.00, received 1000.00, protocol 0.00, platform 0.00'
    );
  });

  it('A9 (B): requester wins: refunded 1,000, received 980, protocol 10, platform 10', () => {
    const b = join(K, [{ kind: 'refunded', amount: K }], [refunded(K, 980n * USDC, 10n * USDC, 10n * USDC)]);
    expect(b.totals).toMatchObject({
      requesterReceived: '980000000',
      vaultProtocolFee: '10000000',
      integratorPaid: '10000000',
      kernelFee: '0',
    });
    expect(breakdownSummary(verifiedAmounts(b), K.toString(), usdc)).toBe(
      'refunded 1000.00, received 980.00, protocol 10.00, platform 10.00'
    );
  });

  it('A15: a blocked integrator is credited, not paid', () => {
    const b = join(K, [{ kind: 'released', amount: 990n * USDC }], [released(990n * USDC, 980n * USDC, 10n * USDC, true)]);
    expect(b.totals).toMatchObject({ integratorPaid: '0', integratorCredited: '10000000', providerReceived: '980000000' });
    expect(verifiedAmounts(b).providerSidePlatformFee).toBe(10n * USDC);
  });

  it('A16: a blocked fee recipient: the protocol refund fee is credited', () => {
    const b = join(
      K,
      [{ kind: 'refunded', amount: K }],
      [refunded(K, 980n * USDC, 10n * USDC, 10n * USDC, { protocol: true })]
    );
    expect(b.totals).toMatchObject({
      requesterReceived: '980000000',
      vaultProtocolFee: '10000000',
      protocolCredited: '10000000',
      integratorPaid: '10000000',
    });
  });

  it('A14: a paid mediator is a movement without a vault fee', () => {
    const b = join(
      K,
      [
        { kind: 'refunded', amount: 900n * USDC },
        { kind: 'mediator', amount: 100n * USDC },
      ],
      [refunded(900n * USDC, 882n * USDC, 9n * USDC, 9n * USDC)]
    );
    expect(b.totals).toMatchObject({ requesterReceived: '882000000', mediatorReceived: '100000000', kernelFee: '0' });
  });

  it('an open escrow: the remaining principal is not a fee', () => {
    const b = join(K, [{ kind: 'released', amount: 247_500_000n }], [released(247_500_000n, 245n * USDC, 2_500_000n)], 750n * USDC);
    expect(b.totals.kernelFee).toBe('2500000');
  });

  it('a plain-behavior escrow has no splits: kernel amounts are what the parties received', () => {
    const b = join(K, [{ kind: 'released', amount: 990n * USDC }], []);
    expect(b.totals).toMatchObject({ providerReceived: '990000000', kernelFee: '10000000', integratorPaid: '0' });
  });

  it('refuses a vault split whose kernel amount matches no kernel payment', () => {
    expect(() => join(K, [{ kind: 'released', amount: 990n * USDC }], [released(989n * USDC, 979n * USDC, 10n * USDC)])).toThrow(
      /matches no kernel payment/
    );
    expect(() => join(K, [{ kind: 'released', amount: K }], [refunded(K, 980n * USDC, 10n * USDC, 10n * USDC)])).toThrow(
      /matches no kernel payment/
    );
  });

  it('nothing paid out yet: no summary line', () => {
    const b = join(K, [], [], K);
    expect(breakdownSummary(verifiedAmounts(b), K.toString(), usdc)).toBeUndefined();
  });
});
