import { integratorProviderTarget, previewDisputeRefund, refundFees } from './rules';

const USDC = 1_000_000n;

describe('FeeSplitVault fee rules', () => {
  describe('provider side: min(floor(N*b/(10000-p)), floor(D*b/10000))', () => {
    it('A3: 1,000 settled at 100 bps gives the integrator 10.000000', () => {
      expect(integratorProviderTarget(990n * USDC, 1000n * USDC, 100, 100)).toBe(10n * USDC);
    });

    it('A5: thirds accumulate to 3.333333, 6.666666, 10.000000', () => {
      const deposit = 1000n * USDC;
      expect(integratorProviderTarget(330_000_000n, deposit, 100, 100)).toBe(3_333_333n);
      expect(integratorProviderTarget(660_000_000n, deposit, 100, 100)).toBe(6_666_666n);
      expect(integratorProviderTarget(990_000_000n, deposit, 100, 100)).toBe(10n * USDC);
    });

    it('A10: the documented +1 unit over 1% of gross', () => {
      expect(integratorProviderTarget(990_000_099n, 2000n * USDC, 100, 100)).toBe(10_000_001n);
    });

    it('A19 and A21: below the kernel minimum fee the share follows the net amount', () => {
      expect(integratorProviderTarget(950_000n, USDC, 100, 100)).toBe(9_595n);
      expect(integratorProviderTarget(50_000n, 100_000n, 100, 100)).toBe(505n);
    });

    it('the deposit clamp binds when the whole deposit reaches the provider side', () => {
      expect(integratorProviderTarget(1000n * USDC, 1000n * USDC, 100, 100)).toBe(10n * USDC);
      expect(integratorProviderTarget(1000n * USDC, 1000n * USDC, 1000, 100)).toBe(100n * USDC);
    });

    it('uses the locked protocol rate, not a fixed 1%', () => {
      expect(integratorProviderTarget(490n * USDC, 1000n * USDC, 100, 200)).toBe(5n * USDC);
      expect(integratorProviderTarget(495n * USDC, 1000n * USDC, 100, 200)).toBe(5_051_020n);
    });
  });

  describe('refund side after a dispute', () => {
    const fresh = { refundSide: 0n, protocolTaken: 0n, integratorTaken: 0n };

    it('A9 (B): 1,000 refunded pays 10 protocol and 10 integrator', () => {
      expect(previewDisputeRefund(1000n * USDC, 100, 100)).toEqual({
        requesterAmount: 980n * USDC,
        protocolFee: 10n * USDC,
        integratorFee: 10n * USDC,
      });
    });

    it('A7 (B) and A10 (B) amounts', () => {
      expect(previewDisputeRefund(600n * USDC, 100, 100).requesterAmount).toBe(588n * USDC);
      expect(previewDisputeRefund(999_999_901n, 100, 100)).toEqual({
        requesterAmount: 979_999_903n,
        protocolFee: 9_999_999n,
        integratorFee: 9_999_999n,
      });
    });

    it('A24: the integrator rate on a refund is min(b, p)', () => {
      const split = previewDisputeRefund(1000n * USDC, 100, 1000);
      expect(split.integratorFee).toBe(10n * USDC);
      expect(split.integratorFee).toBe(split.protocolFee);
      expect(previewDisputeRefund(1000n * USDC, 200, 100)).toEqual({
        requesterAmount: 970n * USDC,
        protocolFee: 20n * USDC,
        integratorFee: 10n * USDC,
      });
    });

    it('fees are the rise of the cumulative floors', () => {
      const first = refundFees(fresh, 150n, 100, 100);
      expect(first).toEqual({ protocolFee: 1n, integratorFee: 1n });
      const state = { refundSide: 150n, protocolTaken: 1n, integratorTaken: 1n };
      expect(refundFees(state, 49n, 100, 100)).toEqual({ protocolFee: 0n, integratorFee: 0n });
      expect(refundFees(state, 50n, 100, 100)).toEqual({ protocolFee: 1n, integratorFee: 1n });
    });

    it('a one-unit refund that steps both floors: the integrator fee gives way first', () => {
      const state = { refundSide: 19n, protocolTaken: 0n, integratorTaken: 0n };
      expect(refundFees(state, 1n, 500, 500)).toEqual({ protocolFee: 1n, integratorFee: 0n });
      const after = { refundSide: 20n, protocolTaken: 1n, integratorTaken: 0n };
      expect(refundFees(after, 5n, 500, 500)).toEqual({ protocolFee: 0n, integratorFee: 1n });
    });
  });
});
