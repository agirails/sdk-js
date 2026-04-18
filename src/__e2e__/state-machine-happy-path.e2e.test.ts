/**
 * E2E: ACTP state machine happy path against MockRuntime.
 *
 * Drives a single transaction through every legal transition:
 *   INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED
 *
 * No negotiation involved — this exercises the kernel state-machine
 * invariants from CLAUDE.md (Single-Page state machine) end-to-end.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Wallet } from 'ethers';
import { MockRuntime } from '../runtime/MockRuntime';
import { MockStateManager } from '../runtime/MockStateManager';

const QUOTE_TTL = 60;

describe('E2E: ACTP state machine — full happy path', () => {
  let testDir: string;
  let runtime: MockRuntime;
  let providerWallet: ReturnType<typeof Wallet.createRandom>;
  let buyerWallet: ReturnType<typeof Wallet.createRandom>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-happy-'));
    runtime = new MockRuntime(new MockStateManager(testDir));
    providerWallet = Wallet.createRandom();
    buyerWallet = Wallet.createRandom();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('walks INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED', async () => {
    await runtime.mintTokens(buyerWallet.address, '100000000');

    // INITIATED — buyer creates the transaction.
    const txId = await runtime.createTransaction({
      provider: providerWallet.address,
      requester: buyerWallet.address,
      amount: '5000000', // $5 USDC base units
      deadline: Math.floor(Date.now() / 1000) + QUOTE_TTL + 3600,
      serviceDescription: JSON.stringify({ service: 'happy-path-e2e' }),
    });
    let tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('INITIATED');

    // QUOTED — provider quotes (raw transition path; the canonical AIP-2
    // signed-quote path is exercised by the negotiation E2E and unit
    // tests). Use the proof field so MockRuntime stamps a quoteHash.
    await runtime.transitionState(txId, 'QUOTED', '0x' + 'a'.repeat(64));
    tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('QUOTED');

    // COMMITTED — buyer locks escrow at the quoted amount.
    await runtime.linkEscrow(txId, '5000000');
    tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('COMMITTED');

    // IN_PROGRESS — provider acknowledges work has started.
    await runtime.transitionState(txId, 'IN_PROGRESS');
    tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('IN_PROGRESS');

    // DELIVERED — provider submits delivery proof.
    await runtime.transitionState(txId, 'DELIVERED', '0x' + 'b'.repeat(64));
    tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('DELIVERED');

    // SETTLED — fast-forward past the dispute window, then settle.
    const txAtDelivered = tx!;
    if (txAtDelivered.disputeWindow) {
      const windowEnd = Number(txAtDelivered.disputeWindow);
      const currentNow = runtime.time.now();
      const deltaToWindow = windowEnd - currentNow;
      if (deltaToWindow > 0) {
        runtime.time.advanceTime(deltaToWindow + 1);
      }
    }
    await runtime.transitionState(txId, 'SETTLED');
    tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('SETTLED');
  });

  it('walks INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED → DISPUTED → SETTLED', async () => {
    await runtime.mintTokens(buyerWallet.address, '100000000');
    const txId = await runtime.createTransaction({
      provider: providerWallet.address,
      requester: buyerWallet.address,
      amount: '5000000',
      deadline: Math.floor(Date.now() / 1000) + QUOTE_TTL + 3600,
      serviceDescription: JSON.stringify({ service: 'dispute-path-e2e' }),
    });
    await runtime.transitionState(txId, 'QUOTED', '0x' + 'c'.repeat(64));
    await runtime.linkEscrow(txId, '5000000');
    await runtime.transitionState(txId, 'IN_PROGRESS');
    await runtime.transitionState(txId, 'DELIVERED', '0x' + 'd'.repeat(64));

    // Dispute opened within window (no time advance needed).
    await runtime.transitionState(txId, 'DISPUTED');
    let tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('DISPUTED');

    // Resolution: settle in buyer's favor (MockRuntime allows raw transition).
    await runtime.transitionState(txId, 'SETTLED');
    tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('SETTLED');
  });

  it('CANCELLED is reachable from INITIATED before any commit', async () => {
    const txId = await runtime.createTransaction({
      provider: providerWallet.address,
      requester: buyerWallet.address,
      amount: '5000000',
      deadline: Math.floor(Date.now() / 1000) + QUOTE_TTL + 3600,
      serviceDescription: JSON.stringify({ service: 'cancel-path-e2e' }),
    });
    await runtime.transitionState(txId, 'CANCELLED');
    const tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('CANCELLED');
  });
});
