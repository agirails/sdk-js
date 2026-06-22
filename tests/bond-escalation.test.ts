/**
 * P2-4 — BondEscalationClient unit tests (TS side).
 *
 * Mirrors python-sdk-v2/tests/test_dispute/test_bond_escalation.py 1:1 and
 * consumes the SAME shared cross-SDK fixture
 * `DISPUTE SYSTEM/test-vectors/bond-escalation-vectors.json`.
 *
 * Proves, with a mock contract (no live chain):
 *   1. Each IBondEscalation write method builds the CORRECT calldata
 *      (4-byte selector + ABI-encoded args == what `Interface.encodeFunctionData`
 *      produces independently).
 *   2. getDisputeState decodes the disputes() tuple to the fixture-expected
 *      DisputeState (the Py twin asserts the identical fixture).
 *   3. The two pure quote helpers match every fixture row.
 */

import fs from 'fs';
import path from 'path';
import { Interface } from 'ethers';

import BondEscalationABI from '../src/abi/BondEscalation.json';
import {
  BondEscalationClient,
  IBondEscalationContract,
} from '../src/dispute/BondEscalation';
import { AIRuling, Ruling } from '../src/types/dispute';

// PARITY: test_bond_escalation.py — same fixture, same assertions.
const VECTORS_DIR = path.resolve(__dirname, '../../../DISPUTE SYSTEM/test-vectors');
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(VECTORS_DIR, 'bond-escalation-vectors.json'), 'utf-8')
);

const IFACE = new Interface(BondEscalationABI as any);

/**
 * Mock BondEscalation contract that records the calldata each write builds and
 * the positional args each function is called with. `disputes()` returns a
 * configurable tuple.
 */
function makeMockContract(disputesTuple?: unknown[]): {
  contract: IBondEscalationContract;
  calls: Array<{ method: string; args: unknown[]; data: string }>;
} {
  const calls: Array<{ method: string; args: unknown[]; data: string }> = [];
  const iface = new Interface(BondEscalationABI as any);

  const contract: IBondEscalationContract = {
    interface: iface,
    getFunction(name: string) {
      const fn = (...args: unknown[]) => {
        const data = iface.encodeFunctionData(name, args as any);
        calls.push({ method: name, args, data });
        return Promise.resolve({
          hash: '0xmocktxhash',
          wait: async () => ({ hash: '0xmocktxhash' }),
        });
      };
      (fn as any).estimateGas = async () => 100000n;
      return fn as any;
    },
    async disputes() {
      return disputesTuple as unknown;
    },
  };

  return { contract, calls };
}

function makeClient(disputesTuple?: unknown[]) {
  const { contract, calls } = makeMockContract(disputesTuple);
  const client = new BondEscalationClient({
    address: '0x000000000000000000000000000000000000dEaD',
    signer: {} as any,
    contract,
  });
  return { client, calls };
}

const TX_ID = '0xabcdef0000000000000000000000000000000000000000000000000000000001';
const DISPUTE_ID = '0x1234567890123456789012345678901234567890123456789012345678901234';

describe('P2-4 BondEscalationClient — quote helpers (shared fixture)', () => {
  test('quoteInitialBond matches every fixture row', () => {
    for (const row of FIXTURE.quoteInitialBond) {
      const got = BondEscalationClient.quoteInitialBond(BigInt(row.escrowAmount));
      expect(got.toString()).toBe(row.expected);
    }
  });

  test('quoteEscalationBond matches every fixture row', () => {
    for (const row of FIXTURE.quoteEscalationBond) {
      const got = BondEscalationClient.quoteEscalationBond(BigInt(row.currentBond));
      expect(got.toString()).toBe(row.expected);
    }
  });

  test('quoteInitialBond enforces the $1 floor and 2% rate', () => {
    expect(BondEscalationClient.quoteInitialBond(0n)).toBe(1_000_000n);
    expect(BondEscalationClient.quoteInitialBond(100_000_000n)).toBe(2_000_000n);
  });

  test('quoteEscalationBond doubles then caps at $500', () => {
    expect(BondEscalationClient.quoteEscalationBond(1_000_000n)).toBe(2_000_000n);
    expect(BondEscalationClient.quoteEscalationBond(300_000_000n)).toBe(500_000_000n);
  });
});

describe('P2-4 BondEscalationClient — getDisputeState decode (shared fixture)', () => {
  test('decodes the disputes() tuple identically to the fixture (open/split)', async () => {
    const fx = FIXTURE.getDisputeState;
    const { client } = makeClient(fx.tuple);
    const state = await client.getDisputeState(fx.disputeId);
    expect(state.txId).toBe(fx.expected.txId);
    expect(state.disputeId).toBe(fx.expected.disputeId);
    expect(Number(state.tier)).toBe(fx.expected.tier);
    expect(Number(state.ruling)).toBe(fx.expected.ruling);
    expect(state.splitBps).toBe(fx.expected.splitBps);
    expect(state.resolved).toBe(fx.expected.resolved);
  });

  test('decodes a resolved non-split dispute', async () => {
    const fx = FIXTURE.getDisputeStateResolved;
    const { client } = makeClient(fx.tuple);
    const state = await client.getDisputeState(fx.disputeId);
    expect(Number(state.tier)).toBe(fx.expected.tier);
    expect(Number(state.ruling)).toBe(fx.expected.ruling);
    expect(state.resolved).toBe(true);
  });

  test('static decodeDisputeState handles named ethers Result shape', () => {
    const named: Record<string, unknown> = {
      transactionId: TX_ID,
      currentRuling: 1,
      splitBps: 0,
      tier: 2,
      resolved: false,
    };
    const state = BondEscalationClient.decodeDisputeState(DISPUTE_ID, named);
    expect(state.txId).toBe(TX_ID);
    expect(Number(state.tier)).toBe(2);
    expect(Number(state.ruling)).toBe(Ruling.REQUESTER_WINS);
  });
});

describe('P2-4 BondEscalationClient — calldata per IBondEscalation method', () => {
  test('openDispute', async () => {
    const { client, calls } = makeClient();
    const { disputeId } = await client.openDispute(TX_ID);
    expect(calls[0].method).toBe('openDispute');
    expect(calls[0].data).toBe(IFACE.encodeFunctionData('openDispute', [TX_ID]));
    // disputeId is the deterministic keccak256(abi.encode("ACTP_DISPUTE_V1", txId))
    expect(disputeId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('submitAIRuling builds the AIRuling tuple + signatures calldata', async () => {
    const { client, calls } = makeClient();
    const ruling: AIRuling = {
      disputeId: DISPUTE_ID,
      ruling: Ruling.SPLIT,
      confidence: 9500,
      splitBps: 6000,
      timestamp: 1700000000,
      reasoningHash: '0x' + '11'.repeat(32),
      bundleHash: '0x' + '22'.repeat(32),
    };
    const sigs = ['0x' + 'ab'.repeat(65), '0x' + 'cd'.repeat(65)];
    await client.submitAIRuling(ruling, sigs);
    const tuple = [
      ruling.disputeId,
      ruling.ruling,
      ruling.confidence,
      ruling.splitBps,
      ruling.timestamp,
      ruling.reasoningHash,
      ruling.bundleHash,
    ];
    expect(calls[0].method).toBe('submitAIRuling');
    expect(calls[0].data).toBe(
      IFACE.encodeFunctionData('submitAIRuling', [DISPUTE_ID, tuple, sigs])
    );
  });

  test('proposeDirectly', async () => {
    const { client, calls } = makeClient();
    await client.proposeDirectly(DISPUTE_ID, Ruling.SPLIT, 6500);
    expect(calls[0].data).toBe(
      IFACE.encodeFunctionData('proposeDirectly', [DISPUTE_ID, 2, 6500])
    );
  });

  test('challenge', async () => {
    const { client, calls } = makeClient();
    await client.challenge(DISPUTE_ID, Ruling.REQUESTER_WINS, 0);
    expect(calls[0].data).toBe(
      IFACE.encodeFunctionData('challenge', [DISPUTE_ID, 1, 0])
    );
  });

  test('finalize', async () => {
    const { client, calls } = makeClient();
    await client.finalize(DISPUTE_ID);
    expect(calls[0].data).toBe(IFACE.encodeFunctionData('finalize', [DISPUTE_ID]));
  });

  test('escalateToUMA', async () => {
    const { client, calls } = makeClient();
    const cid = 'bafybeigdyrztabcdefghijklmnopqrstuvwxyz1234567890';
    await client.escalateToUMA(DISPUTE_ID, cid);
    expect(calls[0].data).toBe(
      IFACE.encodeFunctionData('escalateToUMA', [DISPUTE_ID, cid])
    );
  });

  test('claimEscalationRefund', async () => {
    const { client, calls } = makeClient();
    await client.claimEscalationRefund(DISPUTE_ID);
    expect(calls[0].data).toBe(
      IFACE.encodeFunctionData('claimEscalationRefund', [DISPUTE_ID])
    );
  });

  test('syncExternalResolution', async () => {
    const { client, calls } = makeClient();
    await client.syncExternalResolution(DISPUTE_ID);
    expect(calls[0].data).toBe(
      IFACE.encodeFunctionData('syncExternalResolution', [DISPUTE_ID])
    );
  });

  test('forceResolveStale', async () => {
    const { client, calls } = makeClient();
    await client.forceResolveStale(DISPUTE_ID);
    expect(calls[0].data).toBe(
      IFACE.encodeFunctionData('forceResolveStale', [DISPUTE_ID])
    );
  });
});

describe('P2-4 BondEscalationClient — config guards', () => {
  test('rejects confirmations < 1', () => {
    const { contract } = makeMockContract();
    expect(
      () =>
        new BondEscalationClient({
          address: '0x000000000000000000000000000000000000dEaD',
          signer: {} as any,
          contract,
          confirmations: 0,
        })
    ).toThrow(/confirmations must be >= 1/);
  });

  test('getAddress / getContract accessors', () => {
    const { client } = makeClient();
    expect(client.getAddress()).toBe('0x000000000000000000000000000000000000dEaD');
    expect(client.getContract()).toBeDefined();
  });
});
