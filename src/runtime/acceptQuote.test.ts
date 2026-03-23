/**
 * acceptQuote() Test Suite
 *
 * Tests cover:
 * 1. Happy path: updates amount, state stays QUOTED
 * 2. Wrong state: revert from INITIATED, COMMITTED
 * 3. Below minimum: revert if newAmount <= 0
 * 4. Deadline expired: revert if past deadline
 * 5. Event emitted: QuoteAccepted with correct old/new amounts
 * 6. Full flow: create → quote → acceptQuote → linkEscrow → COMMITTED
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  MockRuntime,
  TransactionNotFoundError,
  InvalidStateTransitionError,
  DeadlinePassedError,
  InvalidAmountError,
} from './MockRuntime';
import { CreateTransactionParams } from './IACTPRuntime';
import { MockStateManager } from './MockStateManager';

describe('acceptQuote', () => {
  let testDir: string;
  let stateManager: MockStateManager;
  let runtime: MockRuntime;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-quote-test-'));
    stateManager = new MockStateManager(testDir);
    runtime = new MockRuntime(stateManager);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createTxParams(overrides?: Partial<CreateTransactionParams>): CreateTransactionParams {
    return {
      provider: '0xProvider',
      requester: '0xRequester',
      amount: '1000000', // 1 USDC
      deadline: runtime.time.now() + 86400,
      disputeWindow: 172800,
      serviceDescription: 'Test service',
      ...overrides,
    };
  }

  async function createQuotedTransaction(): Promise<string> {
    const txId = await runtime.createTransaction(createTxParams());
    await runtime.transitionState(txId, 'QUOTED');
    return txId;
  }

  // 1. Happy path
  it('should update amount and stay in QUOTED state', async () => {
    const txId = await createQuotedTransaction();

    await runtime.acceptQuote(txId, '2000000'); // 2 USDC

    const tx = await runtime.getTransaction(txId);
    expect(tx).not.toBeNull();
    expect(tx!.state).toBe('QUOTED');
    expect(tx!.amount).toBe('2000000');
  });

  // 2. Wrong state: INITIATED
  it('should revert from INITIATED state', async () => {
    const txId = await runtime.createTransaction(createTxParams());

    await expect(runtime.acceptQuote(txId, '2000000')).rejects.toThrow(
      InvalidStateTransitionError
    );
  });

  // 2b. Wrong state: COMMITTED
  it('should revert from COMMITTED state', async () => {
    await runtime.mintTokens('0xRequester', '10000000');
    const txId = await runtime.createTransaction(createTxParams());
    await runtime.linkEscrow(txId, '1000000');

    const tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('COMMITTED');

    await expect(runtime.acceptQuote(txId, '2000000')).rejects.toThrow(
      InvalidStateTransitionError
    );
  });

  // 3. Transaction not found
  it('should revert for non-existent transaction', async () => {
    const fakeTxId = '0x' + '0'.repeat(64);

    await expect(runtime.acceptQuote(fakeTxId, '2000000')).rejects.toThrow(
      TransactionNotFoundError
    );
  });

  // 4. Below minimum (zero/negative amount)
  it('should revert if newAmount is zero', async () => {
    const txId = await createQuotedTransaction();

    await expect(runtime.acceptQuote(txId, '0')).rejects.toThrow(
      InvalidAmountError
    );
  });

  // 5. Deadline expired
  it('should revert if deadline has passed', async () => {
    const txId = await createQuotedTransaction();

    // Advance time past deadline
    await runtime.time.advanceTime(86401);

    await expect(runtime.acceptQuote(txId, '2000000')).rejects.toThrow(
      DeadlinePassedError
    );
  });

  // 6. Event emitted
  it('should emit QuoteAccepted event with correct amounts', async () => {
    const txId = await createQuotedTransaction();

    await runtime.acceptQuote(txId, '2000000');

    const tx = await runtime.getTransaction(txId);
    const quoteEvent = tx!.events.find(e => e.type === 'QuoteAccepted');
    expect(quoteEvent).toBeDefined();
    expect(quoteEvent!.data.oldAmount).toBe('1000000');
    expect(quoteEvent!.data.newAmount).toBe('2000000');
  });

  // 7. Full flow: create → quote → acceptQuote → linkEscrow → COMMITTED
  it('should complete full negotiation flow', async () => {
    await runtime.mintTokens('0xRequester', '10000000');

    // Create transaction (INITIATED)
    const txId = await runtime.createTransaction(createTxParams());
    let tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('INITIATED');

    // Provider submits quote (INITIATED → QUOTED)
    await runtime.transitionState(txId, 'QUOTED');
    tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('QUOTED');

    // Requester accepts quote with new amount
    await runtime.acceptQuote(txId, '1500000');
    tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('QUOTED');
    expect(tx!.amount).toBe('1500000');

    // Link escrow to commit (QUOTED → COMMITTED)
    await runtime.linkEscrow(txId, '1500000');
    tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('COMMITTED');
  });

  // 8. Multiple acceptQuote calls
  it('should allow multiple acceptQuote calls while QUOTED', async () => {
    const txId = await createQuotedTransaction();

    await runtime.acceptQuote(txId, '2000000');
    await runtime.acceptQuote(txId, '1500000');

    const tx = await runtime.getTransaction(txId);
    expect(tx!.amount).toBe('1500000');
    expect(tx!.state).toBe('QUOTED');
  });
});
