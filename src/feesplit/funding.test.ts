import { safeValidatePayParams, validatePayParams } from '../types/adapter';
import { ValidationError } from '../errors';
import {
  DisputeFeeNotAcknowledgedError,
  FeeSplitPreflightMissingError,
  FeeSplitTermsNotLockedError,
  FeeSplitVaultUnavailableError,
  IntegratorNotApprovedError,
} from './errors';
import { assertFeeSplitPreflight, assertFeeSplitTermsLocked, resolveFeeSplitFunding } from './funding';
import { previewDisputeRefund } from './rules';
import type { FeeSplitReader, IntegratorTerms, LockedTerms } from './types';

const VAULT = '0x00000000000000000000000000000000000000aa';
const PROVIDER = '0x00000000000000000000000000000000000000b0';
const INTEGRATOR = '0x00000000000000000000000000000000000000c0';
const VAULTS = [{ address: VAULT, funding: true }];
const AMOUNT = 1_000_000_000n;

class RecordingReader implements FeeSplitReader {
  calls: string[] = [];
  approvedBps = 100;
  liveProtocolBps = 100;
  lockedProtocolBps = 100;
  locked: LockedTerms | undefined;

  integratorMaxBps(): Promise<number> {
    this.calls.push('integratorMaxBps');
    return Promise.resolve(this.approvedBps);
  }

  protocolBps(txId?: string): Promise<number> {
    this.calls.push(txId === undefined ? 'protocolBps:live' : 'protocolBps:locked');
    return Promise.resolve(txId === undefined ? this.liveProtocolBps : this.lockedProtocolBps);
  }

  previewDisputeRefund(_vault: string, refundAmount: bigint, protocolBps: number, bps: number) {
    this.calls.push('previewDisputeRefund');
    const split = previewDisputeRefund(refundAmount, protocolBps, bps);
    return Promise.resolve({
      refundAmount: refundAmount.toString(),
      requesterAmount: split.requesterAmount.toString(),
      protocolFee: split.protocolFee.toString(),
      integratorFee: split.integratorFee.toString(),
    });
  }

  lockedTerms(): Promise<LockedTerms> {
    if (!this.locked) throw new Error('no locked terms configured');
    return Promise.resolve(this.locked);
  }
}

const payoutOnly: IntegratorTerms = { address: INTEGRATOR, bps: 100, profile: 'PAYOUT_ONLY' };
const bothAfterDispute: IntegratorTerms = { address: INTEGRATOR, bps: 100, profile: 'BOTH_AFTER_DISPUTE' };

function request(reader: RecordingReader, overrides: Partial<Parameters<typeof resolveFeeSplitFunding>[0]> = {}) {
  return resolveFeeSplitFunding({ provider: PROVIDER, amount: AMOUNT, vaults: VAULTS, reader, ...overrides });
}

describe('resolveFeeSplitFunding', () => {
  it('resolves to undefined without terms and reads nothing: plain funding is untouched', async () => {
    const reader = new RecordingReader();
    await expect(request(reader)).resolves.toBeUndefined();
    expect(reader.calls).toEqual([]);
  });

  it('uses the client default when the call names no terms, and the call terms when it does', async () => {
    const reader = new RecordingReader();
    reader.approvedBps = 300;
    const fromDefault = await request(reader, { defaults: payoutOnly });
    expect(fromDefault?.terms).toEqual(payoutOnly);
    const override: IntegratorTerms = { address: INTEGRATOR, bps: 300, profile: 'PAYOUT_ONLY' };
    const fromCall = await request(reader, { defaults: payoutOnly, integrator: override });
    expect(fromCall?.terms).toEqual(override);
    expect(fromCall?.vault).toBe(VAULT);
  });

  it('refuses terms the provider did not approve on chain', async () => {
    const reader = new RecordingReader();
    reader.approvedBps = 99;
    await expect(request(reader, { integrator: payoutOnly })).rejects.toBeInstanceOf(IntegratorNotApprovedError);
    reader.approvedBps = 0;
    await expect(request(reader, { integrator: payoutOnly })).rejects.toBeInstanceOf(IntegratorNotApprovedError);
  });

  it('refuses when no vault funds new escrows', async () => {
    const reader = new RecordingReader();
    const retired = [{ address: VAULT, funding: false }];
    await expect(request(reader, { integrator: payoutOnly, vaults: retired })).rejects.toBeInstanceOf(
      FeeSplitVaultUnavailableError
    );
    await expect(request(reader, { integrator: payoutOnly, vaults: [] })).rejects.toBeInstanceOf(
      FeeSplitVaultUnavailableError
    );
  });

  it('validates the terms before any read', async () => {
    const reader = new RecordingReader();
    const bad: IntegratorTerms[] = [
      { address: 'not-an-address', bps: 100, profile: 'PAYOUT_ONLY' },
      { address: PROVIDER, bps: 100, profile: 'PAYOUT_ONLY' },
      { address: INTEGRATOR, bps: 0, profile: 'PAYOUT_ONLY' },
      { address: INTEGRATOR, bps: 1001, profile: 'PAYOUT_ONLY' },
      { address: INTEGRATOR, bps: 1.5, profile: 'PAYOUT_ONLY' },
    ];
    for (const terms of bad) {
      await expect(request(reader, { integrator: terms })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(reader.calls).toEqual([]);
  });

  describe('profile BOTH_AFTER_DISPUTE', () => {
    it('is refused without an acknowledgment for this call, with the disclosure in the error', async () => {
      const reader = new RecordingReader();
      const refused = request(reader, { integrator: bothAfterDispute });
      await expect(refused).rejects.toBeInstanceOf(DisputeFeeNotAcknowledgedError);
      await expect(refused).rejects.toMatchObject({
        ifDisputedRefundQuote: {
          refundAmount: '1000000000',
          requesterAmount: '980000000',
          protocolFee: '10000000',
          integratorFee: '10000000',
        },
      });
    });

    it('a client-level default never counts as acknowledgment', async () => {
      const reader = new RecordingReader();
      await expect(request(reader, { defaults: bothAfterDispute })).rejects.toBeInstanceOf(DisputeFeeNotAcknowledgedError);
      await expect(request(reader, { defaults: bothAfterDispute, acknowledgeDisputeFee: false })).rejects.toBeInstanceOf(
        DisputeFeeNotAcknowledgedError
      );
    });

    it('with the acknowledgment returns the 980 / 10 / 10 preview for 1,000 USDC', async () => {
      const reader = new RecordingReader();
      const funding = await request(reader, { defaults: bothAfterDispute, acknowledgeDisputeFee: true });
      expect(funding?.ifDisputedRefundQuote).toEqual({
        refundAmount: '1000000000',
        requesterAmount: '980000000',
        protocolFee: '10000000',
        integratorFee: '10000000',
      });
    });

    it('prices the preview at the locked rate of an existing transaction, else at the live rate', async () => {
      const reader = new RecordingReader();
      reader.liveProtocolBps = 200;
      reader.lockedProtocolBps = 100;
      const live = await request(reader, { integrator: bothAfterDispute, acknowledgeDisputeFee: true });
      expect(live?.ifDisputedRefundQuote?.protocolFee).toBe('20000000');
      const locked = await request(reader, { integrator: bothAfterDispute, acknowledgeDisputeFee: true, txId: '0x01' });
      expect(locked?.ifDisputedRefundQuote?.protocolFee).toBe('10000000');
      expect(reader.calls).toContain('protocolBps:live');
      expect(reader.calls).toContain('protocolBps:locked');
    });

    it('PAYOUT_ONLY needs no acknowledgment and carries no preview', async () => {
      const reader = new RecordingReader();
      const funding = await request(reader, { integrator: payoutOnly });
      expect(funding?.ifDisputedRefundQuote).toBeUndefined();
      expect(reader.calls).toEqual(['integratorMaxBps']);
    });
  });
});

describe('the preflight token', () => {
  it('accepts exactly what the preflight returned', async () => {
    const funding = await request(new RecordingReader(), { integrator: payoutOnly });
    if (!funding) throw new Error('expected funding');
    expect(() => assertFeeSplitPreflight(funding)).not.toThrow();
  });

  it('rejects hand-built funding, a copied token with other terms, and another vault', async () => {
    const funding = await request(new RecordingReader(), { integrator: payoutOnly });
    if (!funding) throw new Error('expected funding');
    expect(() =>
      assertFeeSplitPreflight({ vault: VAULT, terms: payoutOnly, token: { kind: 'FeeSplitPreflightToken' } })
    ).toThrow(FeeSplitPreflightMissingError);
    expect(() => assertFeeSplitPreflight({ ...funding, terms: { ...funding.terms, bps: 200 } })).toThrow(
      FeeSplitPreflightMissingError
    );
    expect(() => assertFeeSplitPreflight({ ...funding, terms: bothAfterDispute })).toThrow(FeeSplitPreflightMissingError);
    expect(() => assertFeeSplitPreflight({ ...funding, vault: PROVIDER })).toThrow(FeeSplitPreflightMissingError);
  });

  it('a refused preflight issues no usable token', async () => {
    const reader = new RecordingReader();
    await expect(request(reader, { integrator: bothAfterDispute })).rejects.toBeInstanceOf(DisputeFeeNotAcknowledgedError);
    expect(() =>
      assertFeeSplitPreflight({ vault: VAULT, terms: bothAfterDispute, token: { kind: 'FeeSplitPreflightToken' } })
    ).toThrow(FeeSplitPreflightMissingError);
  });
});

describe('assertFeeSplitTermsLocked', () => {
  const lockedAs = (overrides: Partial<LockedTerms>): LockedTerms => ({
    integrator: INTEGRATOR,
    bps: 100,
    profile: 'PAYOUT_ONLY',
    state: 'PENDING_CONFIRM',
    protocolBps: 0,
    disputed: false,
    used: true,
    ...overrides,
  });

  it('passes when the vault locked the requested terms', async () => {
    const reader = new RecordingReader();
    const funding = await request(reader, { integrator: payoutOnly });
    if (!funding) throw new Error('expected funding');
    reader.locked = lockedAs({});
    await expect(assertFeeSplitTermsLocked(reader, '0x01', funding)).resolves.toMatchObject({ bps: 100 });
  });

  it('throws when the escrow has no terms or other terms', async () => {
    const reader = new RecordingReader();
    const funding = await request(reader, { integrator: payoutOnly });
    if (!funding) throw new Error('expected funding');
    for (const locked of [
      lockedAs({ state: 'NONE', bps: 0 }),
      lockedAs({ bps: 200 }),
      lockedAs({ profile: 'BOTH_AFTER_DISPUTE' }),
      lockedAs({ integrator: PROVIDER }),
    ]) {
      reader.locked = locked;
      await expect(assertFeeSplitTermsLocked(reader, '0x01', funding)).rejects.toBeInstanceOf(FeeSplitTermsNotLockedError);
    }
  });
});

describe('validated pay parameters', () => {
  it('keep the integrator terms and the acknowledgment, and reject malformed terms', () => {
    const terms = { address: '0x' + '33'.repeat(20), bps: 100, profile: 'BOTH_AFTER_DISPUTE' };
    const parsed = validatePayParams({ to: '0x' + '22'.repeat(20), amount: '1000', integrator: terms, acknowledgeDisputeFee: true });
    expect(parsed.integrator).toEqual(terms);
    expect(parsed.acknowledgeDisputeFee).toBe(true);
    expect(safeValidatePayParams({ to: '0x' + '22'.repeat(20), amount: '1000', integrator: { ...terms, bps: 1001 } }).success).toBe(false);
    expect(safeValidatePayParams({ to: '0x' + '22'.repeat(20), amount: '1000', integrator: { ...terms, profile: 'OTHER' } }).success).toBe(false);
  });
});
