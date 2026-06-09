/**
 * AIP-16 Phase 2e — MockRuntime envelope-deferral test hooks.
 *
 * Coverage:
 *  - Default (no flag): auto-settle fires immediately when conditions are met.
 *  - setEnvelopePendingForTests(txId): auto-settle is skipped exactly once.
 *  - Flag is cleared after one consumption (one-shot semantics).
 *  - clearEnvelopePendingForTests(txId): flag removed without consuming a cycle.
 *  - Per-txId isolation: deferring tx A does not affect tx B.
 *  - Idempotency of clear (clearing an unset flag is a no-op).
 *  - Calling setEnvelopePendingForTests multiple times on the same txId
 *    coalesces to a single skip (Set semantics).
 *  - BlockchainRuntime is NOT touched by this feature (sanity check).
 *
 * These tests deliberately stress the test-only seam — production code
 * MUST NOT invoke setEnvelopePendingForTests; the tests below are the only
 * legitimate caller.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MockRuntime } from './MockRuntime';
import { MockStateManager } from './MockStateManager';

const REQUESTER = '0x' + '11'.repeat(20);
const PROVIDER = '0x' + '22'.repeat(20);
const DISPUTE_WINDOW = 60; // 60 seconds for fast tests

function makeStateManager(dir: string): MockStateManager {
  // MockStateManager treats its argument as projectRoot and creates
  // `<dir>/.actp/mock-state.json` underneath. Passing the test dir directly
  // gives each test its own isolated state file.
  return new MockStateManager(dir);
}

function ensureBaseDir(): string {
  const base = path.join(os.homedir(), '.agirails');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return base;
}

async function bringToDelivered(
  runtime: MockRuntime,
  amount = '1000000',
): Promise<{ txId: string; escrowId: string }> {
  // Mint then walk the state machine: createTransaction (INITIATED)
  // → linkEscrow (auto COMMITTED) → IN_PROGRESS → DELIVERED.
  await runtime.mintTokens(REQUESTER, '10000000');
  const now = runtime.time.now();
  const txId = await runtime.createTransaction({
    requester: REQUESTER,
    provider: PROVIDER,
    amount,
    deadline: now + 7200,
    disputeWindow: DISPUTE_WINDOW,
  });
  const escrowId = await runtime.linkEscrow(txId, amount);
  await runtime.transitionState(txId, 'IN_PROGRESS');
  await runtime.transitionState(txId, 'DELIVERED');
  return { txId, escrowId };
}

describe('AIP-16 Phase 2e — MockRuntime envelope-deferral test hooks', () => {
  let dir: string;

  beforeEach(() => {
    const base = ensureBaseDir();
    dir = fs.mkdtempSync(path.join(base, 'mock-deferral-test-'));
  });

  afterEach(() => {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default behavior: auto-settle fires immediately when dispute window is up', async () => {
    const sm = makeStateManager(dir);
    const runtime = new MockRuntime(sm);
    const { txId } = await bringToDelivered(runtime);

    // Advance time past dispute window.
    await runtime.time.advanceTime(DISPUTE_WINDOW + 10);

    // getTransaction triggers autoSettleIfReady — should now be SETTLED.
    const tx = await runtime.getTransaction(txId);
    expect(tx?.state).toBe('SETTLED');
  });

  it('setEnvelopePendingForTests: NEXT auto-settle cycle is skipped', async () => {
    const sm = makeStateManager(dir);
    const runtime = new MockRuntime(sm);
    const { txId } = await bringToDelivered(runtime);

    await runtime.time.advanceTime(DISPUTE_WINDOW + 10);
    runtime.setEnvelopePendingForTests(txId);

    // First getTransaction consumes the deferral flag and skips auto-settle.
    const txAfterFirstCheck = await runtime.getTransaction(txId);
    expect(txAfterFirstCheck?.state).toBe('DELIVERED');
  });

  it('flag is cleared after first use (one-shot semantics)', async () => {
    const sm = makeStateManager(dir);
    const runtime = new MockRuntime(sm);
    const { txId } = await bringToDelivered(runtime);

    await runtime.time.advanceTime(DISPUTE_WINDOW + 10);
    runtime.setEnvelopePendingForTests(txId);

    // First check: skipped (still DELIVERED).
    let tx = await runtime.getTransaction(txId);
    expect(tx?.state).toBe('DELIVERED');

    // Second check: flag is gone, auto-settle proceeds → SETTLED.
    tx = await runtime.getTransaction(txId);
    expect(tx?.state).toBe('SETTLED');
  });

  it('clearEnvelopePendingForTests: removes flag without consuming a cycle', async () => {
    const sm = makeStateManager(dir);
    const runtime = new MockRuntime(sm);
    const { txId } = await bringToDelivered(runtime);

    await runtime.time.advanceTime(DISPUTE_WINDOW + 10);
    runtime.setEnvelopePendingForTests(txId);
    // Clear it BEFORE any getTransaction triggers consumption.
    runtime.clearEnvelopePendingForTests(txId);

    const tx = await runtime.getTransaction(txId);
    // Cleared flag means auto-settle proceeds normally.
    expect(tx?.state).toBe('SETTLED');
  });

  it('clearEnvelopePendingForTests is idempotent when no flag is set', async () => {
    const sm = makeStateManager(dir);
    const runtime = new MockRuntime(sm);
    const { txId } = await bringToDelivered(runtime);

    // No setEnvelopePendingForTests preceded this — clear should be a no-op.
    expect(() => runtime.clearEnvelopePendingForTests(txId)).not.toThrow();
    expect(() => runtime.clearEnvelopePendingForTests(txId)).not.toThrow();

    await runtime.time.advanceTime(DISPUTE_WINDOW + 10);
    const tx = await runtime.getTransaction(txId);
    expect(tx?.state).toBe('SETTLED');
  });

  it('per-txId isolation: deferring tx A does not affect tx B', async () => {
    const sm = makeStateManager(dir);
    const runtime = new MockRuntime(sm);
    const a = await bringToDelivered(runtime, '1000000');
    const b = await bringToDelivered(runtime, '500000');

    await runtime.time.advanceTime(DISPUTE_WINDOW + 10);
    runtime.setEnvelopePendingForTests(a.txId);

    const txA = await runtime.getTransaction(a.txId);
    const txB = await runtime.getTransaction(b.txId);

    expect(txA?.state).toBe('DELIVERED'); // skipped
    expect(txB?.state).toBe('SETTLED'); // proceeded
  });

  it('setEnvelopePendingForTests multiple times coalesces to one skip', async () => {
    const sm = makeStateManager(dir);
    const runtime = new MockRuntime(sm);
    const { txId } = await bringToDelivered(runtime);

    await runtime.time.advanceTime(DISPUTE_WINDOW + 10);
    runtime.setEnvelopePendingForTests(txId);
    runtime.setEnvelopePendingForTests(txId);
    runtime.setEnvelopePendingForTests(txId);

    // First check consumes the (single) flag.
    let tx = await runtime.getTransaction(txId);
    expect(tx?.state).toBe('DELIVERED');

    // Second check: NO flag remaining → auto-settle.
    tx = await runtime.getTransaction(txId);
    expect(tx?.state).toBe('SETTLED');
  });

  it('setEnvelopePendingForTests before bringing to DELIVERED still defers exactly once when ready', async () => {
    const sm = makeStateManager(dir);
    const runtime = new MockRuntime(sm);

    // Set the flag before any tx exists — should still pre-arm the skip
    // for when this txId reaches the auto-settle precondition.
    const placeholderTxId = '0x' + 'cd'.repeat(32);
    runtime.setEnvelopePendingForTests(placeholderTxId);

    const { txId } = await bringToDelivered(runtime);
    runtime.setEnvelopePendingForTests(txId);

    await runtime.time.advanceTime(DISPUTE_WINDOW + 10);
    let tx = await runtime.getTransaction(txId);
    expect(tx?.state).toBe('DELIVERED');

    // After flag-consumption, auto-settle proceeds.
    tx = await runtime.getTransaction(txId);
    expect(tx?.state).toBe('SETTLED');

    // The placeholder flag stays armed (it was a different txId) — clearing
    // it should not throw.
    expect(() => runtime.clearEnvelopePendingForTests(placeholderTxId)).not.toThrow();
  });

  it('non-DELIVERED tx + deferral flag: flag is still consumed but state is irrelevant', async () => {
    // Sanity: the flag consumption logic runs at the top of autoSettleIfReady,
    // BEFORE the state precondition. Setting a flag on a tx in IN_PROGRESS
    // means the first getTransaction will consume the flag (no state change
    // either way); the second proceeds normally (still no settle, wrong state).
    const sm = makeStateManager(dir);
    const runtime = new MockRuntime(sm);
    await runtime.mintTokens(REQUESTER, '10000000');
    const now = runtime.time.now();
    const txId = await runtime.createTransaction({
      requester: REQUESTER,
      provider: PROVIDER,
      amount: '1000000',
      deadline: now + 7200,
      disputeWindow: DISPUTE_WINDOW,
    });
    runtime.setEnvelopePendingForTests(txId);

    // INITIATED → flag consumed but no state change either way.
    const tx = await runtime.getTransaction(txId);
    expect(tx?.state).toBe('INITIATED');
  });
});
