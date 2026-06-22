/**
 * P2-9 — DisputeClient facade unit tests (TS side).
 *
 * Mirrors python-sdk-v2/tests/test_dispute/test_dispute_client.py 1:1 and
 * consumes the SAME shared cross-SDK fixture
 * `DISPUTE SYSTEM/test-vectors/dispute-client-status-vectors.json`.
 *
 * Proves, with mock sub-clients (no live chain):
 *   1. The §9 sub-state decode (`decodeDisputeSubState` + `getDisputeStatus`)
 *      matches every fixture row — the single cross-SDK decode.
 *   2. The facade composes the five primitives and exposes them via accessors;
 *      unconfigured accessors throw; the split indexer is always present.
 *   3. `getDisputeStatus` throws a clear error when the bond client is absent.
 */

import fs from 'fs';
import path from 'path';

import {
  DisputeClient,
  decodeDisputeSubState,
} from '../src/dispute/DisputeClient';
import { BondEscalationClient } from '../src/dispute/BondEscalation';
import { CompositeMediator } from '../src/dispute/CompositeMediator';
import { EvaluatorClient } from '../src/dispute/EvaluatorClient';
import { UMAHelper } from '../src/dispute/UMAHelper';
import { DisputeSplitIndexer } from '../src/reputation/DisputeSplitIndexer';

// PARITY: test_dispute_client.py — same fixture, same assertions.
const VECTORS_DIR = path.resolve(__dirname, '../../../DISPUTE SYSTEM/test-vectors');
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(VECTORS_DIR, 'dispute-client-status-vectors.json'), 'utf-8')
);

/**
 * A mock BondEscalation contract whose `disputes()` returns a fixed tuple — the
 * only surface getDisputeStatus reads.
 */
function makeBondClientWithTuple(tuple: unknown[]): BondEscalationClient {
  const contract: any = {
    interface: { encodeFunctionData: () => '0x' },
    getFunction: () => {
      const fn = () => Promise.resolve({ hash: '0xmock', wait: async () => ({ hash: '0xmock' }) });
      (fn as any).estimateGas = async () => 0n;
      return fn;
    },
    disputes: async () => tuple,
  };
  return new BondEscalationClient({
    address: '0x0000000000000000000000000000000000000001',
    signer: {} as any,
    contract,
    confirmations: 1,
  });
}

describe('DisputeClient — §9 sub-state decode (cross-SDK golden fixture)', () => {
  for (const vec of FIXTURE.vectors as any[]) {
    it(`decodeDisputeSubState: ${vec.name}`, () => {
      expect(decodeDisputeSubState(vec.tuple)).toBe(vec.expected.substate);
    });

    it(`getDisputeStatus: ${vec.name}`, async () => {
      const client = new DisputeClient({ bond: makeBondClientWithTuple(vec.tuple) });
      const status = await client.getDisputeStatus(vec.disputeId);
      expect(status.substate).toBe(vec.expected.substate);
      expect(status.tier).toBe(vec.expected.tier);
      expect(status.resolved).toBe(vec.expected.resolved);
      expect(status.ruling).toBe(vec.expected.ruling);
      expect(status.splitBps).toBe(vec.expected.splitBps);
      expect(status.disputeId).toBe(vec.disputeId);
    });
  }
});

describe('DisputeClient — composition + accessors', () => {
  it('exposes all five primitives via accessors when configured', () => {
    const bond = makeBondClientWithTuple(FIXTURE.vectors[0].tuple);
    const mediator = new CompositeMediator(
      '0x0000000000000000000000000000000000000002',
      {} as any
    );
    const uma = new UMAHelper({
      bondEscalationAddress: '0x0000000000000000000000000000000000000001',
      oov3Address: '0x0000000000000000000000000000000000000003',
      usdcAddress: '0x0000000000000000000000000000000000000004',
      signer: {} as any,
      // injected stubs so no real Contract is constructed
      bondEscalation: { interface: {}, getFunction: () => (() => {}) as any, disputeToAssertion: async () => '0x' } as any,
      oov3: { interface: {}, getFunction: () => (() => {}) as any } as any,
      usdc: { interface: {}, getFunction: () => (() => {}) as any } as any,
      confirmations: 1,
    });
    const evaluator = new EvaluatorClient({
      baseUrl: 'https://evaluator.example',
      paymentClient: { pay: async () => ({}) } as any,
    });
    const splitIndexer = new DisputeSplitIndexer();

    const client = new DisputeClient({ bond, mediator, uma, evaluator, splitIndexer });

    expect(client.bond).toBe(bond);
    expect(client.mediator).toBe(mediator);
    expect(client.uma).toBe(uma);
    expect(client.evaluator).toBe(evaluator);
    expect(client.splitIndexer).toBe(splitIndexer);
    expect(client.hasBond()).toBe(true);
    expect(client.hasMediator()).toBe(true);
    expect(client.hasUMA()).toBe(true);
    expect(client.hasEvaluator()).toBe(true);
  });

  it('split indexer is ALWAYS present even with no config', () => {
    const client = new DisputeClient();
    expect(client.splitIndexer).toBeInstanceOf(DisputeSplitIndexer);
    expect(client.hasBond()).toBe(false);
    expect(client.hasMediator()).toBe(false);
    expect(client.hasUMA()).toBe(false);
    expect(client.hasEvaluator()).toBe(false);
  });

  it('unconfigured accessors throw a clear error', () => {
    const client = new DisputeClient();
    expect(() => client.bond).toThrow(/not configured/);
    expect(() => client.mediator).toThrow(/not configured/);
    expect(() => client.uma).toThrow(/not configured/);
    expect(() => client.evaluator).toThrow(/not configured/);
  });

  it('getDisputeStatus throws when the bond client is absent', async () => {
    const client = new DisputeClient();
    await expect(client.getDisputeStatus('0x' + '11'.repeat(32))).rejects.toThrow(/not configured/);
  });

  it('recordOutcomes feeds the split indexer', () => {
    const client = new DisputeClient();
    client.recordOutcomes([
      { provider: '0xabc', requester: '0xdef', kind: 'disputeSplitRecorded', remaining: 0n },
    ]);
    expect(client.splitIndexer.size()).toBe(1);
  });
});
