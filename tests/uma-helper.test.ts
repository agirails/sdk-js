/**
 * P2-7 — UMAHelper unit tests (TS side): the requester self-dispute DVM helper
 * (AIP-14b §8.6).
 *
 * Mirrors python-sdk-v2/tests/test_dispute/test_uma_helper.py 1:1 and consumes
 * the SAME shared cross-SDK fixture
 * `DISPUTE SYSTEM/test-vectors/uma-self-dispute-vectors.json`.
 *
 * Proves, with mock contracts (no live chain):
 *   1. requesterForceDVM issues EXACTLY the call sequence
 *      approve → escalateToUMA → (read assertionId) → approve → disputeAssertion,
 *      in that order, with the correct target contract + calldata per step.
 *   2. quoteSelfDisputeCost returns {total $1000, recover $750, lose $250}.
 *   3. The §8.6 asymmetry warning AND the "settleAssertion yourself or risk a
 *      30-day forced 50/50 split" warning are BOTH present in the source
 *      (a grep test reads the .ts file).
 */

import fs from 'fs';
import path from 'path';
import { Interface } from 'ethers';

import BondEscalationABI from '../src/abi/BondEscalation.json';
import IOptimisticOracleV3ABI from '../src/abi/IOptimisticOracleV3.json';
import ERC20ABI from '../src/abi/ERC20.json';
import {
  UMAHelper,
  UMA_BOND,
  SELF_DISPUTE_TOTAL,
  SELF_DISPUTE_RECOVER,
  SELF_DISPUTE_LOSS,
  IDisputeContract,
  IERC20Contract,
  IOptimisticOracleV3Contract,
} from '../src/dispute/UMAHelper';

// PARITY: test_uma_helper.py — same fixture, same assertions.
const VECTORS_DIR = path.resolve(__dirname, '../../../DISPUTE SYSTEM/test-vectors');
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(VECTORS_DIR, 'uma-self-dispute-vectors.json'), 'utf-8')
);

const BOND_IFACE = new Interface(BondEscalationABI as any);
const OOV3_IFACE = new Interface(IOptimisticOracleV3ABI as any);
const ERC20_IFACE = new Interface(ERC20ABI as any);

const BOND_ADDR = '0x000000000000000000000000000000000000BE11';
const OOV3_ADDR = '0x2aBf1Bd76655de80eDB3086114315Eec75AF500c';
const USDC_ADDR = '0x000000000000000000000000000000000000C0dc';

/**
 * A single recorded call, tagged with the target contract so the test can
 * assert the cross-contract ORDER (approve hits usdc, escalateToUMA hits
 * bondEscalation, etc.).
 */
interface RecordedCall {
  target: 'usdc' | 'bondEscalation' | 'oov3';
  method: string;
  args: unknown[];
  data: string;
}

function makeContract(
  target: RecordedCall['target'],
  iface: Interface,
  sink: RecordedCall[],
  extra?: Partial<Record<string, (...a: unknown[]) => Promise<unknown>>>
): any {
  return {
    interface: iface,
    getFunction(name: string) {
      const fn = (...args: unknown[]) => {
        const data = iface.encodeFunctionData(name, args as any);
        sink.push({ target, method: name, args, data });
        return Promise.resolve({
          hash: `0x${target}txhash`,
          wait: async () => ({ hash: `0x${target}txhash` }),
        });
      };
      (fn as any).estimateGas = async () => 100000n;
      return fn as any;
    },
    ...extra,
  };
}

function makeHelper(assertionId: string = FIXTURE.requesterForceDVM.assertionId) {
  const calls: RecordedCall[] = [];
  const bondEscalation = makeContract('bondEscalation', BOND_IFACE, calls, {
    // disputeToAssertion is a READ between the two writes.
    disputeToAssertion: async (_disputeId: unknown) => assertionId,
  }) as IDisputeContract;
  const oov3 = makeContract('oov3', OOV3_IFACE, calls, {
    // getMinimumBond is a direct READ (not a recorded write); default regime = $500.
    getMinimumBond: async (_currency: unknown) => UMA_BOND,
  }) as IOptimisticOracleV3Contract;
  const usdc = makeContract('usdc', ERC20_IFACE, calls) as IERC20Contract;

  const helper = new UMAHelper({
    bondEscalationAddress: BOND_ADDR,
    oov3Address: OOV3_ADDR,
    usdcAddress: USDC_ADDR,
    signer: {} as any,
    bondEscalation,
    oov3,
    usdc,
  });
  return { helper, calls };
}

describe('P2-7 UMAHelper — quoteSelfDisputeCost (shared fixture)', () => {
  test('returns {total $1000, recover $750, lose $250}', () => {
    const cost = UMAHelper.quoteSelfDisputeCost();
    const fx = FIXTURE.quoteSelfDisputeCost;
    expect(cost.total.toString()).toBe(fx.total);
    expect(cost.recover.toString()).toBe(fx.recover);
    expect(cost.lose.toString()).toBe(fx.lose);
  });

  test('the dollar amounts are exactly $1000 / $750 / $250 (6-decimal USDC)', () => {
    const cost = UMAHelper.quoteSelfDisputeCost();
    expect(cost.total).toBe(1_000_000_000n); // $1000
    expect(cost.recover).toBe(750_000_000n); // $750
    expect(cost.lose).toBe(250_000_000n); // $250
    // identity: total - recover == lose (UMA Store fee = 50% of losing bond)
    expect(cost.total - cost.recover).toBe(cost.lose);
  });

  test('constants are internally consistent', () => {
    expect(UMA_BOND).toBe(500_000_000n);
    expect(SELF_DISPUTE_TOTAL).toBe(UMA_BOND * 2n);
    expect(SELF_DISPUTE_RECOVER).toBe(UMA_BOND + UMA_BOND / 2n);
    expect(SELF_DISPUTE_LOSS).toBe(SELF_DISPUTE_TOTAL - SELF_DISPUTE_RECOVER);
  });
});

describe('P2-7 UMAHelper — requesterForceDVM call sequence (shared fixture)', () => {
  test('issues EXACTLY approve → escalateToUMA → read → approve → disputeAssertion', async () => {
    const fx = FIXTURE.requesterForceDVM;
    const { helper, calls } = makeHelper(fx.assertionId);

    const result = await helper.requesterForceDVM(
      fx.disputeId,
      fx.evidenceCID,
      fx.reasoningCID,
      fx.disputer
    );

    // The 4 WRITE calls (the read between #2 and #3 is not a getFunction write).
    expect(calls.map((c) => `${c.target}.${c.method}`)).toEqual([
      'usdc.approve',
      'bondEscalation.escalateToUMA',
      'usdc.approve',
      'oov3.disputeAssertion',
    ]);

    // The fixture's declared sequence (excluding the read step) MUST match.
    const writeSteps = (fx.sequence as Array<{ target: string; method: string }>).filter(
      (s) => s.method !== 'disputeToAssertion'
    );
    expect(calls.map((c) => ({ target: c.target, method: c.method }))).toEqual(
      writeSteps.map((s) => ({ target: s.target, method: s.method }))
    );

    // Step 1: approve(bondEscalation, $500).
    expect(calls[0].data).toBe(
      ERC20_IFACE.encodeFunctionData('approve', [BOND_ADDR, UMA_BOND])
    );
    // Step 2: escalateToUMA(disputeId, evidenceCID, reasoningCID) — BLOCKER-2.
    expect(calls[1].data).toBe(
      BOND_IFACE.encodeFunctionData('escalateToUMA', [
        fx.disputeId,
        fx.evidenceCID,
        fx.reasoningCID,
      ])
    );
    expect(calls[1].data.slice(0, 10)).toBe('0xea487f8a');
    // Step 3 (read) produced the assertionId returned to the caller.
    expect(result.assertionId).toBe(fx.assertionId);
    // Step 4: approve(oov3, $500).
    expect(calls[2].data).toBe(
      ERC20_IFACE.encodeFunctionData('approve', [OOV3_ADDR, UMA_BOND])
    );
    // Step 5: disputeAssertion(assertionId, disputer).
    expect(calls[3].data).toBe(
      OOV3_IFACE.encodeFunctionData('disputeAssertion', [fx.assertionId, fx.disputer])
    );
  });

  test('the read (disputeToAssertion) happens AFTER escalateToUMA and BEFORE disputeAssertion', async () => {
    const fx = FIXTURE.requesterForceDVM;
    const order: string[] = [];
    const calls: RecordedCall[] = [];

    const bondEscalation = {
      interface: BOND_IFACE,
      getFunction(name: string) {
        return (...args: unknown[]) => {
          order.push(`write:${name}`);
          calls.push({
            target: 'bondEscalation',
            method: name,
            args,
            data: BOND_IFACE.encodeFunctionData(name, args as any),
          });
          return Promise.resolve({ hash: '0xh', wait: async () => ({ hash: '0xh' }) });
        };
      },
      disputeToAssertion: async () => {
        order.push('read:disputeToAssertion');
        return fx.assertionId;
      },
    } as unknown as IDisputeContract;

    const mk = (target: RecordedCall['target'], iface: Interface) =>
      ({
        interface: iface,
        getFunction(name: string) {
          return (...args: unknown[]) => {
            order.push(`write:${name}`);
            return Promise.resolve({ hash: '0xh', wait: async () => ({ hash: '0xh' }) });
          };
        },
        // Direct READ (not a write): does NOT push to `order`.
        getMinimumBond: async (_currency: unknown) => UMA_BOND,
      }) as any;

    const helper = new UMAHelper({
      bondEscalationAddress: BOND_ADDR,
      oov3Address: OOV3_ADDR,
      usdcAddress: USDC_ADDR,
      signer: {} as any,
      bondEscalation,
      oov3: mk('oov3', OOV3_IFACE),
      usdc: mk('usdc', ERC20_IFACE),
    });

    await helper.requesterForceDVM(fx.disputeId, fx.evidenceCID, fx.reasoningCID, fx.disputer);

    const readIdx = order.indexOf('read:disputeToAssertion');
    const escalateIdx = order.indexOf('write:escalateToUMA');
    const disputeIdx = order.indexOf('write:disputeAssertion');
    expect(escalateIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThan(escalateIdx);
    expect(disputeIdx).toBeGreaterThan(readIdx);
  });

  test('getAssertionId reads disputeToAssertion', async () => {
    const fx = FIXTURE.requesterForceDVM;
    const { helper } = makeHelper(fx.assertionId);
    expect(await helper.getAssertionId(fx.disputeId)).toBe(fx.assertionId);
  });

  test('settleAssertion builds settleAssertion calldata on OOV3', async () => {
    const fx = FIXTURE.requesterForceDVM;
    const { helper, calls } = makeHelper(fx.assertionId);
    await helper.settleAssertion(fx.assertionId);
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('oov3');
    expect(calls[0].data).toBe(
      OOV3_IFACE.encodeFunctionData('settleAssertion', [fx.assertionId])
    );
  });
});

describe('P2-7 UMAHelper — dynamic bond parity (getEffectiveBond)', () => {
  function makeHelperWithMinBond(minBond: bigint) {
    const calls: RecordedCall[] = [];
    const bondEscalation = makeContract('bondEscalation', BOND_IFACE, calls, {
      disputeToAssertion: async () => FIXTURE.requesterForceDVM.assertionId,
    }) as IDisputeContract;
    const oov3 = makeContract('oov3', OOV3_IFACE, calls, {
      getMinimumBond: async (_c: unknown) => minBond,
    }) as IOptimisticOracleV3Contract;
    const usdc = makeContract('usdc', ERC20_IFACE, calls) as IERC20Contract;
    const helper = new UMAHelper({
      bondEscalationAddress: BOND_ADDR,
      oov3Address: OOV3_ADDR,
      usdcAddress: USDC_ADDR,
      signer: {} as any,
      bondEscalation,
      oov3,
      usdc,
    });
    return { helper, calls };
  }

  test('getEffectiveBond returns $500 when the oracle minimum is below it', async () => {
    const { helper } = makeHelperWithMinBond(100_000_000n); // $100 < $500
    expect(await helper.getMinimumBond()).toBe(100_000_000n);
    expect(await helper.getEffectiveBond()).toBe(UMA_BOND); // max($500, $100) = $500
  });

  test('getEffectiveBond returns the oracle minimum when it exceeds $500', async () => {
    const raised = 800_000_000n; // $800 > $500
    const { helper } = makeHelperWithMinBond(raised);
    expect(await helper.getEffectiveBond()).toBe(raised);
  });

  test('requesterForceDVM approves the RAISED effective bond, not a fixed $500', async () => {
    const raised = 800_000_000n;
    const fx = FIXTURE.requesterForceDVM;
    const { helper, calls } = makeHelperWithMinBond(raised);
    await helper.requesterForceDVM(fx.disputeId, fx.evidenceCID, fx.reasoningCID, fx.disputer);
    // Both approvals must use the raised bond (matching BondEscalation.sol).
    expect(calls[0].data).toBe(
      ERC20_IFACE.encodeFunctionData('approve', [BOND_ADDR, raised])
    );
    expect(calls[2].data).toBe(
      ERC20_IFACE.encodeFunctionData('approve', [OOV3_ADDR, raised])
    );
  });
});

describe('P2-7 UMAHelper — config guards', () => {
  test('rejects confirmations < 1', () => {
    expect(
      () =>
        new UMAHelper({
          bondEscalationAddress: BOND_ADDR,
          oov3Address: OOV3_ADDR,
          usdcAddress: USDC_ADDR,
          signer: {} as any,
          confirmations: 0,
        })
    ).toThrow(/confirmations must be >= 1/);
  });

  test('address accessors', () => {
    const { helper } = makeHelper();
    expect(helper.getBondEscalationAddress()).toBe(BOND_ADDR);
    expect(helper.getOOV3Address()).toBe(OOV3_ADDR);
  });
});

describe('P2-7 UMAHelper — required docstring warnings (grep over source)', () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../src/dispute/UMAHelper.ts'),
    'utf-8'
  );

  test('contains the §8.6 asymmetry warning', () => {
    // The §8.6 asymmetry: escalateToUMA is provider-directional, rational only
    // for the provider side; the requester normally wins for free via finalize().
    expect(SRC).toMatch(/§8\.6 ASYMMETRY WARNING/);
    expect(SRC).toMatch(/provider-directional/i);
    expect(SRC).toMatch(/asymmetr/i);
  });

  test('contains the "settleAssertion yourself or risk a 30-day forced 50/50 split" warning', () => {
    expect(SRC).toMatch(
      /[Cc]all\s+`?settleAssertion`?\s+yourself\s+or\s+risk\s+a\s+30-day\s+forced\s+50\/50\s+split/
    );
  });
});
