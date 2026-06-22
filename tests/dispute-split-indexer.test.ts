/**
 * P2-8 — Reputation split-rate surfacing + DisputeSplitIndexer (TS side).
 *
 * Mirrors python-sdk-v2/tests/test_reputation/test_dispute_split_indexer.py 1:1
 * and consumes the SAME shared cross-SDK fixture
 * `DISPUTE SYSTEM/test-vectors/dispute-split-indexer-vectors.json`.
 *
 * Proves:
 *   1. reportDisputeSplit writes value=0 (NEUTRAL) + tag1='actp_dispute_split',
 *      never throws, and dedups in-session.
 *   2. The tag STRING is identical across both SDKs ('actp_dispute_split').
 *   3. getSplitRate is the headline ~14% case: 1 split / 6 settled = 1/7,
 *      where the single split is an ADMIN-CANCELLED (kernel DISPUTED→CANCELLED) —
 *      proving OQ-11 counts admin-CANCELLED at IDENTICAL weight in the headline.
 *   4. DisputeSplitRecorded + kernel DISPUTED→CANCELLED weighted identically.
 *   5. ZERO-REMAINING RULE: a drained split (remaining==0) still counts as a
 *      split, and classifyPayout reports NO 1-wei payout (phantom sentinel).
 *   6. Per-agent scoping + div-by-zero safety.
 */

import fs from 'fs';
import path from 'path';

import {
  DisputeSplitIndexer,
  isSplitKind,
  outcomeFromSplitRecorded,
  DisputeOutcome,
} from '../src/reputation/DisputeSplitIndexer';
import { ReputationReporter, IERC8004ReputationRegistry } from '../src/erc8004/ReputationReporter';
import { ACTP_FEEDBACK_TAGS } from '../src/types/erc8004';

// PARITY: test_dispute_split_indexer.py — same fixture, same assertions.
const VECTORS_DIR = path.resolve(__dirname, '../../../DISPUTE SYSTEM/test-vectors');
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(VECTORS_DIR, 'dispute-split-indexer-vectors.json'), 'utf-8')
);

/** Build a DisputeSplitIndexer seeded from a fixture `outcomes` array. */
function indexerFromFixture(outcomes: any[]): DisputeSplitIndexer {
  const mapped: DisputeOutcome[] = outcomes.map((o) => ({
    provider: o.provider,
    requester: o.requester,
    kind: o.kind,
    remaining: BigInt(o.remaining ?? '0'),
    splitBps: o.splitBps,
    proof: o.proof,
    txId: o.txId,
  }));
  return new DisputeSplitIndexer(mapped);
}

// =====================================================================
// reportDisputeSplit — NEUTRAL value=0 + actp_dispute_split tag
// =====================================================================

describe('P2-8 reportDisputeSplit — neutral split trace (TS)', () => {
  /** Mock registry that records the giveFeedback args. */
  function makeMockRegistry(): {
    registry: IERC8004ReputationRegistry;
    calls: any[][];
    failNext: () => void;
  } {
    const calls: any[][] = [];
    let shouldFail = false;
    const registry: IERC8004ReputationRegistry = {
      async giveFeedback(...args: any[]) {
        if (shouldFail) {
          throw new Error('boom: registry reverted');
        }
        calls.push(args);
        return {
          async wait() {
            return { hash: '0xfeed', blockNumber: 42, gasUsed: 1000n };
          },
        };
      },
      async getSummary() {
        return [0n, 0n, 0] as [bigint, bigint, number];
      },
      async revokeLatest() {
        return { async wait() { return { hash: '0x', blockNumber: 0, gasUsed: 0n }; } };
      },
    };
    return { registry, calls, failNext: () => { shouldFail = true; } };
  }

  function makeReporter(registry: IERC8004ReputationRegistry): ReputationReporter {
    return new ReputationReporter({
      network: 'base-sepolia',
      signer: {} as any,
      _testContract: registry,
    });
  }

  test('writes value=0 NEUTRAL + tag1=actp_dispute_split', async () => {
    const { registry, calls } = makeMockRegistry();
    const reporter = makeReporter(registry);

    const result = await reporter.reportDisputeSplit({
      agentId: '42',
      txId: '0xdeadbeef',
      capability: 'code_generation',
      splitBps: 5000,
    });

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    const [agentId, value, decimals, tag1, tag2] = calls[0];
    expect(agentId).toBe('42');
    expect(value).toBe(0); // NEUTRAL — no penalty (INV-4)
    expect(decimals).toBe(0);
    expect(tag1).toBe('actp_dispute_split');
    expect(tag1).toBe(ACTP_FEEDBACK_TAGS.DISPUTE_SPLIT);
    expect(tag2).toBe('code_generation');
  });

  test('never throws — returns null on registry failure', async () => {
    const { registry, failNext } = makeMockRegistry();
    const reporter = makeReporter(registry);
    failNext();
    const result = await reporter.reportDisputeSplit({ agentId: '42', txId: '0xabc' });
    expect(result).toBeNull(); // logged, not thrown
  });

  test('in-session dedup — second report of same txId returns null', async () => {
    const { registry, calls } = makeMockRegistry();
    const reporter = makeReporter(registry);
    await reporter.reportDisputeSplit({ agentId: '42', txId: '0xsame' });
    const second = await reporter.reportDisputeSplit({ agentId: '42', txId: '0xsame' });
    expect(second).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('tag string is the cross-SDK canonical literal', () => {
    // PARITY: identical to Py ACTP_FEEDBACK_TAGS["DISPUTE_SPLIT"].
    expect(ACTP_FEEDBACK_TAGS.DISPUTE_SPLIT).toBe('actp_dispute_split');
  });
});

// =====================================================================
// getSplitRate — the headline ~14% fixture (OQ-11 admin-CANCELLED counted)
// =====================================================================

describe('P2-8 DisputeSplitIndexer.getSplitRate — ~14% headline (TS)', () => {
  test('1 split / 6 settled = 1/7 ≈ 14%, split is admin-CANCELLED', () => {
    const f = FIXTURE.headlineFourteenPercent;
    const indexer = indexerFromFixture(f.outcomes);
    const rate = indexer.getSplitRate(FIXTURE.agent);

    expect(rate.splitCount).toBe(f.expected.splitCount); // 1
    expect(rate.totalDisputes).toBe(f.expected.totalDisputes); // 7
    expect(rate.splitRate).toBeCloseTo(f.expected.splitRate, 12);
    // ~14%
    expect(Math.round(rate.splitRate * 100)).toBe(f.expected.approxPercent);

    // The single split was an admin-CANCELLED kernel transition — prove OQ-11
    // counts it in the HEADLINE (R11 under-count trap closed).
    const breakdown = indexer.getSplitRateBreakdown(FIXTURE.agent);
    expect(breakdown.mediatorSplitCount).toBe(0);
    expect(breakdown.adminSplitCount).toBe(1);
    expect(breakdown.splitRate).toBeCloseTo(f.expected.splitRate, 12); // headline unchanged
  });

  test('mediator-split and admin-split weighted identically', () => {
    const f = FIXTURE.mixedSourceEqualWeight;
    const indexer = indexerFromFixture(f.outcomes);
    const rate = indexer.getSplitRate(FIXTURE.agent);
    const breakdown = indexer.getSplitRateBreakdown(FIXTURE.agent);

    expect(rate.splitCount).toBe(f.expected.splitCount); // 2
    expect(rate.totalDisputes).toBe(f.expected.totalDisputes); // 7
    expect(rate.splitRate).toBeCloseTo(f.expected.splitRate, 12);
    expect(breakdown.mediatorSplitCount).toBe(f.expected.mediatorSplitCount); // 1
    expect(breakdown.adminSplitCount).toBe(f.expected.adminSplitCount); // 1
    // identical weight: 1 mediator + 1 admin == 2 toward the same rate.
    expect(breakdown.mediatorSplitCount + breakdown.adminSplitCount).toBe(rate.splitCount);
  });

  test('per-agent scoping — other agents do not pollute', () => {
    const f = FIXTURE.perAgentScoping;
    const indexer = indexerFromFixture(f.outcomes);
    const rate = indexer.getSplitRate(f.queryAgent);
    expect(rate.splitCount).toBe(f.expected.splitCount); // 1
    expect(rate.totalDisputes).toBe(f.expected.totalDisputes); // 2
    expect(rate.splitRate).toBeCloseTo(f.expected.splitRate, 12); // 0.5
  });

  test('zero disputes — no division by zero', () => {
    const f = FIXTURE.zeroDisputesNoDivByZero;
    const indexer = indexerFromFixture(f.outcomes);
    const rate = indexer.getSplitRate(f.queryAgent);
    expect(rate.splitCount).toBe(0);
    expect(rate.totalDisputes).toBe(0);
    expect(rate.splitRate).toBe(0);
  });
});

// =====================================================================
// ZERO-REMAINING CONSUMER RULE — drained split counts, no phantom payout
// =====================================================================

describe('P2-8 ZERO-REMAINING rule — drained dispute (TS)', () => {
  test('drained splits still count as splits but report NO 1-wei payout', () => {
    const f = FIXTURE.drainedSplitNoPhantomPayout;
    const indexer = indexerFromFixture(f.outcomes);
    const rate = indexer.getSplitRate(FIXTURE.agent);

    // The split STILL counts toward the rate even though escrow was drained.
    expect(rate.splitCount).toBe(f.expected.splitCount); // 2
    expect(rate.totalDisputes).toBe(f.expected.totalDisputes); // 2
    expect(rate.splitRate).toBeCloseTo(f.expected.splitRate, 12); // 1.0

    // But the indexer NEVER surfaces a 1-wei payout — proof amounts are phantom.
    for (const o of indexer.getOutcomes()) {
      const decoded = indexer.classifyPayout(o);
      expect(decoded).not.toBeNull();
      expect(decoded!.phantomSentinel).toBe(true);
      expect(decoded!.payouts.requester).toBe(0n);
      expect(decoded!.payouts.provider).toBe(0n);
      // Hard assertion of the rule: never the 1-wei sentinel.
      expect(decoded!.payouts.requester).not.toBe(1n);
      expect(decoded!.payouts.provider).not.toBe(1n);
    }
    expect(f.expected.phantomPayoutReported).toBe(false);
  });
});

// =====================================================================
// Helpers / parity surface
// =====================================================================

describe('P2-8 indexer helpers (TS)', () => {
  test('isSplitKind — both split kinds true, settled false', () => {
    expect(isSplitKind('disputeSplitRecorded')).toBe(true);
    expect(isSplitKind('kernelDisputedToCancelled')).toBe(true);
    expect(isSplitKind('settled')).toBe(false);
  });

  test('outcomeFromSplitRecorded maps event → outcome', () => {
    const o = outcomeFromSplitRecorded(
      {
        txId: '0x1',
        requester: '0x1111111111111111111111111111111111111111',
        provider: FIXTURE.agent,
        splitBps: 3000,
      },
      1000000n
    );
    expect(o.kind).toBe('disputeSplitRecorded');
    expect(o.provider).toBe(FIXTURE.agent);
    expect(o.splitBps).toBe(3000);
    expect(o.remaining).toBe(1000000n);
  });

  test('classifyPayout returns null when no proof present', () => {
    const indexer = new DisputeSplitIndexer();
    const decoded = indexer.classifyPayout({
      provider: FIXTURE.agent,
      requester: '0x1',
      kind: 'settled',
      remaining: 100n,
    });
    expect(decoded).toBeNull();
  });
});
