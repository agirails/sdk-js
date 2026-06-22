/**
 * P2-5 — CompositeMediator read/event client + decoders (TS side).
 *
 * Mirrors python-sdk-v2/tests/test_dispute/test_composite_mediator.py 1:1 and
 * consumes the SAME shared cross-SDK fixture
 * `DISPUTE SYSTEM/test-vectors/composite-mediator-vectors.json`.
 *
 * Proves:
 *   1. decodeDisputeSplitRecorded decodes a DisputeSplitRecorded log.
 *   2. decodeResolutionProof obeys the ZERO-REMAINING CONSUMER RULE — a drained
 *      dispute (remaining==0) surfaces NO 1-wei payout (phantom sentinel).
 *   3. computeSplitRate counts DisputeSplitRecorded + kernel DISPUTED→CANCELLED
 *      at identical weight (OQ-11) over the fixture rows.
 *   4. EventMonitor surfaces DisputeSplitRecorded, kernel DISPUTED→CANCELLED,
 *      and UMADisputeEscalated.
 *   5. resolve() is NOT a public client method (it's onlyBondEscalation).
 */

import fs from 'fs';
import path from 'path';
import { AbiCoder, Interface } from 'ethers';

import CompositeMediatorABI from '../src/abi/CompositeMediator.json';
import BondEscalationABI from '../src/abi/BondEscalation.json';
import ACTPKernelABI from '../src/abi/ACTPKernel.json';
import {
  CompositeMediator,
  decodeDisputeSplitRecorded,
  decodeResolutionProof,
  computeSplitRate,
} from '../src/dispute/CompositeMediator';
import { EventMonitor } from '../src/protocol/EventMonitor';
import { State } from '../src/types/state';

// PARITY: test_composite_mediator.py — same fixture, same assertions.
const VECTORS_DIR = path.resolve(__dirname, '../../../DISPUTE SYSTEM/test-vectors');
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(VECTORS_DIR, 'composite-mediator-vectors.json'), 'utf-8')
);

const MEDIATOR_IFACE = new Interface(CompositeMediatorABI as any);

/** Build a real ethers-encoded DisputeSplitRecorded log from fixture fields. */
function makeSplitLog(ev: { txId: string; requester: string; provider: string; splitBps: number }) {
  const fragment = MEDIATOR_IFACE.getEvent('DisputeSplitRecorded')!;
  const data = MEDIATOR_IFACE.encodeEventLog(fragment, [
    ev.txId,
    ev.requester,
    ev.provider,
    ev.splitBps,
  ]);
  return {
    topics: data.topics,
    data: data.data,
    blockNumber: 100,
    index: 0,
    transactionHash: '0xfeed',
  };
}

describe('P2-5 decodeDisputeSplitRecorded (TS)', () => {
  test('decodes a raw DisputeSplitRecorded log', () => {
    const ev = FIXTURE.splitRecordedEvent;
    const decoded = decodeDisputeSplitRecorded(makeSplitLog(ev) as any);
    expect(decoded.txId.toLowerCase()).toBe(ev.txId.toLowerCase());
    expect(decoded.requester.toLowerCase()).toBe(ev.requester.toLowerCase());
    expect(decoded.provider.toLowerCase()).toBe(ev.provider.toLowerCase());
    expect(decoded.splitBps).toBe(ev.splitBps);
  });

  test('rejects a non-DisputeSplitRecorded log', () => {
    const kernelIface = new Interface(ACTPKernelABI as any);
    const stFrag = kernelIface.getEvent('StateTransitioned')!;
    const enc = kernelIface.encodeEventLog(stFrag, [
      FIXTURE.splitRecordedEvent.txId,
      State.DISPUTED,
      State.CANCELLED,
      '0x3333333333333333333333333333333333333333',
      1700000000,
    ]);
    expect(() =>
      decodeDisputeSplitRecorded({ topics: enc.topics, data: enc.data } as any)
    ).toThrow(/not a DisputeSplitRecorded/);
  });
});

describe('P2-5 decodeResolutionProof — ZERO-REMAINING CONSUMER RULE (TS)', () => {
  for (const row of FIXTURE.resolutionProofs) {
    test(`${row.name} decodes to the fixture-expected payouts`, () => {
      const decoded = decodeResolutionProof(row.proof, BigInt(row.remaining));
      expect(decoded.isSplit).toBe(row.expected.isSplit);
      expect(decoded.phantomSentinel).toBe(row.expected.phantomSentinel);
      expect(decoded.payouts.requester.toString()).toBe(row.expected.requesterAmount);
      expect(decoded.payouts.provider.toString()).toBe(row.expected.providerAmount);
      if (row.expected.providerAtFault === null) {
        expect(decoded.providerAtFault).toBeUndefined();
      } else {
        expect(decoded.providerAtFault).toBe(row.expected.providerAtFault);
      }
    });
  }

  test('DRAINED dispute: no 1-wei payout is surfaced (phantom sentinel ignored)', () => {
    // The on-chain proof carries a 1-wei sentinel, but remaining==0 → both payouts 0.
    const coder = AbiCoder.defaultAbiCoder();
    const sentinelProof = coder.encode(['uint256', 'uint256', 'bool'], [0n, 1n, false]);
    const decoded = decodeResolutionProof(sentinelProof, 0n);
    expect(decoded.phantomSentinel).toBe(true);
    expect(decoded.payouts.requester).toBe(0n);
    expect(decoded.payouts.provider).toBe(0n);
    // Hard assertion of the rule: the surfaced amount is NEVER the 1-wei sentinel.
    expect(decoded.payouts.provider).not.toBe(1n);
  });
});

describe('P2-5 computeSplitRate — OQ-11 (TS)', () => {
  for (const row of FIXTURE.splitRate) {
    test(`${row.name} matches fixture`, () => {
      const got = computeSplitRate(
        row.splitRecorded,
        row.kernelDisputedToCancelled,
        row.totalDisputes
      );
      expect(got).toBeCloseTo(row.expected, 10);
    });
  }
});

describe('P2-5 CompositeMediator client surface (TS)', () => {
  test('resolve is NOT a public client method (onlyBondEscalation)', () => {
    // resolve() exists on the ABI but is guarded onlyBondEscalation; the SDK
    // client deliberately omits it so callers cannot build a reverting tx.
    expect(MEDIATOR_IFACE.getFunction('resolve')).not.toBeNull(); // exists on-chain
    const client = new CompositeMediator(
      '0x000000000000000000000000000000000000dEaD',
      {} as any
    );
    expect((client as any).resolve).toBeUndefined();
    // No 'resolve' on the prototype or instance public surface.
    const names = new Set<string>();
    let proto = Object.getPrototypeOf(client);
    while (proto && proto !== Object.prototype) {
      for (const n of Object.getOwnPropertyNames(proto)) names.add(n);
      proto = Object.getPrototypeOf(proto);
    }
    expect(names.has('resolve')).toBe(false);
    // The observational surface it DOES expose:
    expect(names.has('getSplitRecordedEvents')).toBe(true);
    expect(names.has('onDisputeSplitRecorded')).toBe(true);
  });
});

describe('P2-5 EventMonitor dispute surfacing (TS)', () => {
  /** Mock ethers Contract that replays a fixed log set through queryFilter. */
  function makeMockContract(abi: any, logsByEvent: Record<string, any[]>) {
    const iface = new Interface(abi);
    return {
      interface: iface,
      filters: new Proxy(
        {},
        {
          get: (_t, name: string) => (..._args: any[]) => ({ __event: name }),
        }
      ),
      async queryFilter(filter: any) {
        return logsByEvent[filter.__event] ?? [];
      },
      on() {},
      off() {},
    } as any;
  }

  function kernelStateLog(from: number, to: number, txId: string, block: number, idx: number) {
    const iface = new Interface(ACTPKernelABI as any);
    const frag = iface.getEvent('StateTransitioned')!;
    const enc = iface.encodeEventLog(frag, [
      txId,
      from,
      to,
      '0x3333333333333333333333333333333333333333',
      1700000000,
    ]);
    const parsed = iface.parseLog({ topics: [...enc.topics], data: enc.data });
    return { args: parsed!.args, blockNumber: block, index: idx };
  }

  function umaLog(disputeId: string, assertionId: string, block: number, idx: number) {
    const iface = new Interface(BondEscalationABI as any);
    const frag = iface.getEvent('UMADisputeEscalated')!;
    const enc = iface.encodeEventLog(frag, [disputeId, assertionId]);
    const parsed = iface.parseLog({ topics: [...enc.topics], data: enc.data });
    return { args: parsed!.args, blockNumber: block, index: idx };
  }

  function splitEventLog(block: number, idx: number) {
    const ev = FIXTURE.splitRecordedEvent;
    const frag = MEDIATOR_IFACE.getEvent('DisputeSplitRecorded')!;
    const enc = MEDIATOR_IFACE.encodeEventLog(frag, [ev.txId, ev.requester, ev.provider, ev.splitBps]);
    const parsed = MEDIATOR_IFACE.parseLog({ topics: [...enc.topics], data: enc.data });
    return { args: parsed!.args, blockNumber: block, index: idx };
  }

  test('getDisputeEvents surfaces all three signals, block-ordered', async () => {
    const TX = FIXTURE.splitRecordedEvent.txId;
    const DISPUTE_ID = '0x' + '11'.repeat(32);
    const ASSERTION_ID = '0x' + '22'.repeat(32);

    const kernel = makeMockContract(ACTPKernelABI, {
      StateTransitioned: [
        // a DISPUTED→CANCELLED (counts) and a noise DELIVERED→SETTLED (ignored)
        kernelStateLog(State.DISPUTED, State.CANCELLED, TX, 10, 0),
        kernelStateLog(State.DELIVERED, State.SETTLED, TX, 11, 0),
      ],
    });
    const mediator = makeMockContract(CompositeMediatorABI, {
      DisputeSplitRecorded: [splitEventLog(12, 0)],
    });
    const bond = makeMockContract(BondEscalationABI, {
      UMADisputeEscalated: [umaLog(DISPUTE_ID, ASSERTION_ID, 9, 0)],
    });

    const monitor = new EventMonitor(kernel, {} as any, mediator, bond);
    const events = await monitor.getDisputeEvents();

    const types = events.map((e) => e.type);
    expect(types).toContain('DisputedToCancelled');
    expect(types).toContain('DisputeSplitRecorded');
    expect(types).toContain('UMADisputeEscalated');
    // DELIVERED→SETTLED noise is NOT surfaced.
    expect(events.filter((e) => e.type === 'DisputedToCancelled')).toHaveLength(1);
    // Block-ordered: UMA(9) < DisputedToCancelled(10) < Split(12).
    expect(events.map((e) => e.blockNumber)).toEqual([9, 10, 12]);
  });

  test('dispute subscriptions throw when their contract is absent', () => {
    const kernel = makeMockContract(ACTPKernelABI, {});
    const monitor = new EventMonitor(kernel, {} as any);
    expect(() => monitor.onDisputeSplitRecorded(() => {})).toThrow(/without a CompositeMediator/);
    expect(() => monitor.onUMADisputeEscalated(() => {})).toThrow(/without a BondEscalation/);
  });
});
