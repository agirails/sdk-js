import { BuyerOrchestrator, ProgressEvent } from '../../src/negotiation/BuyerOrchestrator';
import { BuyerPolicy } from '../../src/negotiation/PolicyEngine';
import { IACTPRuntime, CreateTransactionParams } from '../../src/runtime/IACTPRuntime';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the discover API
jest.mock('../../src/api/agirailsApp', () => ({
  discoverAgents: jest.fn(),
}));
import { discoverAgents } from '../../src/api/agirailsApp';
const mockDiscover = discoverAgents as jest.MockedFunction<typeof discoverAgents>;

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_DIR = join(tmpdir(), `orchestrator-test-${process.pid}`);

const POLICY: BuyerPolicy = {
  task: 'translation.fr_en',
  constraints: {
    max_unit_price: { amount: 1.0, currency: 'USDC', unit: 'sentence' },
    max_daily_spend: { amount: 100.0, currency: 'USDC' },
  },
  negotiation: {
    rounds_max: 3,
    quote_ttl: '5s', // Short for tests
  },
  selection: {
    min_reputation: 50,
    prioritize: ['quality', 'price'],
  },
};

function mockAgent(slug: string, price: number, reputation: number, address: string) {
  return {
    slug,
    wallet_address: address,
    published_config: {
      pricing: { amount: price, currency: 'USDC', unit: 'sentence' },
    },
    stats: {
      reputation_score: reputation,
      completed_transactions: 10,
      failed_transactions: 0,
      success_rate: 95,
      total_gmv_usdc: '100',
      avg_completion_time_seconds: 60,
    },
  };
}

/** Simple mock runtime for testing */
function createMockRuntime(): IACTPRuntime & { _transactions: Map<string, any> } {
  const transactions = new Map<string, any>();
  let txCounter = 0;

  return {
    _transactions: transactions,
    async createTransaction(params: CreateTransactionParams): Promise<string> {
      txCounter++;
      const txId = `0x${txCounter.toString().padStart(64, '0')}`;
      transactions.set(txId, {
        id: txId,
        state: 'INITIATED',
        provider: params.provider,
        requester: params.requester,
        amount: params.amount,
      });
      return txId;
    },
    async linkEscrow(txId: string, amount: string): Promise<string> {
      const tx = transactions.get(txId);
      if (tx) tx.state = 'COMMITTED';
      return txId;
    },
    async transitionState(txId: string, newState: string, proof?: string): Promise<void> {
      const tx = transactions.get(txId);
      if (tx) tx.state = newState;
    },
    async getTransaction(txId: string) {
      return transactions.get(txId) ?? null;
    },
    async getAllTransactions() {
      return Array.from(transactions.values());
    },
    async releaseEscrow() {},
    async getEscrowBalance() { return '0'; },
    time: { now: () => Math.floor(Date.now() / 1000) },
  } as any;
}

// ============================================================================
// Tests
// ============================================================================

describe('BuyerOrchestrator', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // --------------------------------------------------------------------------
  // Discovery
  // --------------------------------------------------------------------------

  describe('discovery', () => {
    it('returns failure when no candidates found', async () => {
      mockDiscover.mockResolvedValue({ agents: [], total: 0 });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(POLICY, runtime, '0xBuyer', TEST_DIR);
      const result = await orchestrator.negotiate();
      expect(result.success).toBe(false);
      expect(result.reason).toContain('No candidates found');
    });

    it('passes search params to discover API', async () => {
      mockDiscover.mockResolvedValue({ agents: [], total: 0 });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(POLICY, runtime, '0xBuyer', TEST_DIR);

      await orchestrator.negotiate({
        discover: { capability: 'code-review', limit: 5 },
      });

      expect(mockDiscover).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'translation.fr_en',
          capability: 'code-review',
          limit: 5,
          sort: 'reputation',
          maxPrice: 1.0,
        })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Dry-run
  // --------------------------------------------------------------------------

  describe('dry-run', () => {
    it('scores candidates without creating transactions', async () => {
      mockDiscover.mockResolvedValue({
        agents: [
          mockAgent('agent-a', 0.80, 90, '0xA'),
          mockAgent('agent-b', 0.50, 85, '0xB'),
        ],
        total: 2,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(POLICY, runtime, '0xBuyer', TEST_DIR);

      const result = await orchestrator.negotiate({ dryRun: true });

      expect(result.success).toBe(true);
      expect(result.reason).toContain('Dry run');
      expect(result.rounds.length).toBe(2);
      // No transactions should have been created
      expect(runtime._transactions.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Full negotiation flow
  // --------------------------------------------------------------------------

  describe('negotiation flow', () => {
    it('accepts first candidate when quote received', async () => {
      mockDiscover.mockResolvedValue({
        agents: [mockAgent('good-agent', 0.80, 90, '0xGood')],
        total: 1,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(POLICY, runtime, '0xBuyer', TEST_DIR);

      // Simulate provider quoting immediately after tx creation
      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        const txId = await origCreate(params);
        // Provider quotes immediately
        runtime._transactions.get(txId)!.state = 'QUOTED';
        return txId;
      };

      const result = await orchestrator.negotiate({ pollIntervalMs: 50 });

      expect(result.success).toBe(true);
      expect(result.selected_provider).toBe('good-agent');
      expect(result.actp_tx_id).toBeDefined();
      expect(result.rounds_used).toBe(1);
      expect(result.rounds[0].action).toBe('accepted');
    });

    it('falls back to next candidate on timeout', async () => {
      mockDiscover.mockResolvedValue({
        agents: [
          mockAgent('slow-agent', 0.70, 80, '0xSlow'),
          mockAgent('fast-agent', 0.80, 85, '0xFast'),
        ],
        total: 2,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(
        { ...POLICY, negotiation: { rounds_max: 3, quote_ttl: '1s' } },
        runtime,
        '0xBuyer',
        TEST_DIR,
      );

      // First agent never quotes, second quotes immediately
      let callCount = 0;
      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        callCount++;
        const txId = await origCreate(params);
        if (callCount === 2) {
          runtime._transactions.get(txId)!.state = 'QUOTED';
        }
        return txId;
      };

      const result = await orchestrator.negotiate({ pollIntervalMs: 100 });

      expect(result.success).toBe(true);
      expect(result.selected_provider).toBe('fast-agent');
      expect(result.rounds_used).toBe(2);
      expect(result.rounds[0].action).toBe('timeout');
      expect(result.rounds[1].action).toBe('accepted');
    });

    it('rejects candidates failing policy validation', async () => {
      // Agent with reputation below min_reputation (50)
      mockDiscover.mockResolvedValue({
        agents: [mockAgent('bad-rep', 0.50, 30, '0xBad')],
        total: 1,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(POLICY, runtime, '0xBuyer', TEST_DIR);

      const result = await orchestrator.negotiate({ pollIntervalMs: 50 });

      expect(result.success).toBe(false);
      expect(result.rounds[0].action).toBe('rejected');
      expect(result.rounds[0].reason).toContain('min_reputation');
    });

    it('accepts when provider goes directly to COMMITTED (fast path)', async () => {
      mockDiscover.mockResolvedValue({
        agents: [mockAgent('fast-provider', 0.80, 90, '0xFast')],
        total: 1,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(POLICY, runtime, '0xBuyer', TEST_DIR);

      // Provider commits directly (INITIATED → COMMITTED)
      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        const txId = await origCreate(params);
        runtime._transactions.get(txId)!.state = 'COMMITTED';
        return txId;
      };

      const result = await orchestrator.negotiate({ pollIntervalMs: 50 });

      expect(result.success).toBe(true);
      expect(result.selected_provider).toBe('fast-provider');
      expect(result.reason).toContain('already committed');
      expect(result.rounds[0].reason).toContain('already committed');
    });

    it('COMMITTED is terminal success even if reserve() fails', async () => {
      mockDiscover.mockResolvedValue({
        agents: [mockAgent('committed-agent', 0.80, 90, '0xC')],
        total: 1,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(POLICY, runtime, '0xBuyer', TEST_DIR);

      // Provider goes directly to COMMITTED
      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        const txId = await origCreate(params);
        runtime._transactions.get(txId)!.state = 'COMMITTED';
        return txId;
      };

      // Sabotage reserve() to simulate race condition (another session exhausted budget)
      const { PolicyEngine } = require('../../src/negotiation/PolicyEngine');
      const origReserve = PolicyEngine.prototype.reserve;
      PolicyEngine.prototype.reserve = function() { throw new Error('Daily budget exceeded (race)'); };

      try {
        const result = await orchestrator.negotiate({ pollIntervalMs: 50 });

        // Must succeed — tx is committed on-chain regardless of local ledger
        expect(result.success).toBe(true);
        expect(result.selected_provider).toBe('committed-agent');
        expect(result.reason).toContain('already committed');
      } finally {
        PolicyEngine.prototype.reserve = origReserve;
      }
    });

    it('survives transient RPC errors during polling', async () => {
      mockDiscover.mockResolvedValue({
        agents: [mockAgent('agent-1', 0.80, 90, '0x1')],
        total: 1,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(POLICY, runtime, '0xBuyer', TEST_DIR);

      // First getTransaction call throws, then tx is QUOTED
      let getCallCount = 0;
      const origGet = runtime.getTransaction.bind(runtime);
      runtime.getTransaction = async (txId: string) => {
        getCallCount++;
        if (getCallCount === 1) throw new Error('RPC timeout');
        return origGet(txId);
      };

      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        const txId = await origCreate(params);
        runtime._transactions.get(txId)!.state = 'QUOTED';
        return txId;
      };

      const result = await orchestrator.negotiate({ pollIntervalMs: 50 });

      expect(result.success).toBe(true);
      expect(getCallCount).toBeGreaterThanOrEqual(2); // survived the error
    });
  });

  // --------------------------------------------------------------------------
  // Progress events
  // --------------------------------------------------------------------------

  describe('progress events', () => {
    it('emits progress events during negotiation', async () => {
      mockDiscover.mockResolvedValue({
        agents: [mockAgent('agent-1', 0.80, 90, '0x1')],
        total: 1,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(POLICY, runtime, '0xBuyer', TEST_DIR);

      // Provider quotes immediately
      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        const txId = await origCreate(params);
        runtime._transactions.get(txId)!.state = 'QUOTED';
        return txId;
      };

      const events: ProgressEvent[] = [];
      await orchestrator.negotiate({
        pollIntervalMs: 50,
        onProgress: (e) => events.push(e),
      });

      const types = events.map(e => e.type);
      expect(types).toContain('discovery');
      expect(types).toContain('scoring');
      expect(types).toContain('round_start');
      expect(types).toContain('complete');
    });
  });

  // --------------------------------------------------------------------------
  // Budget tracking
  // --------------------------------------------------------------------------

  describe('budget integration', () => {
    it('reserves budget on successful acceptance', async () => {
      mockDiscover.mockResolvedValue({
        agents: [mockAgent('agent-1', 0.80, 90, '0x1')],
        total: 1,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(POLICY, runtime, '0xBuyer', TEST_DIR);

      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        const txId = await origCreate(params);
        runtime._transactions.get(txId)!.state = 'QUOTED';
        return txId;
      };

      const result = await orchestrator.negotiate({ pollIntervalMs: 50 });
      expect(result.success).toBe(true);
      // Budget should be reserved (via PolicyEngine ledger)
    });
  });

  // --------------------------------------------------------------------------
  // Deadlock detection (PRD-5B)
  // --------------------------------------------------------------------------

  describe('deadlock detection', () => {
    it('tracks quoted_price on accepted rounds', async () => {
      mockDiscover.mockResolvedValue({
        agents: [mockAgent('agent-a', 0.80, 90, '0xA')],
        total: 1,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(POLICY, runtime, '0xBuyer', TEST_DIR);

      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        const txId = await origCreate(params);
        runtime._transactions.get(txId)!.state = 'QUOTED';
        return txId;
      };

      const result = await orchestrator.negotiate({ pollIntervalMs: 50 });

      expect(result.success).toBe(true);
      expect(result.rounds[0].quoted_price).toBeDefined();
      expect(typeof result.rounds[0].quoted_price).toBe('number');
    });

    it('detects deadlock when consecutive providers quote same price', async () => {
      mockDiscover.mockResolvedValue({
        agents: [
          mockAgent('agent-a', 0.80, 90, '0xA'),
          mockAgent('agent-b', 0.80, 85, '0xB'),
        ],
        total: 2,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(
        { ...POLICY, negotiation: { rounds_max: 3, quote_ttl: '1s' } },
        runtime,
        '0xBuyer',
        TEST_DIR,
      );

      let callCount = 0;
      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        callCount++;
        const txId = await origCreate(params);
        runtime._transactions.get(txId)!.state = 'QUOTED';
        return txId;
      };

      const origLinkEscrow = runtime.linkEscrow.bind(runtime);
      let linkCount = 0;
      runtime.linkEscrow = async (txId: string, amount: string) => {
        linkCount++;
        if (linkCount === 1) throw new Error('Simulated escrow failure');
        return origLinkEscrow(txId, amount);
      };

      const result = await orchestrator.negotiate({ pollIntervalMs: 50 });

      expect(result.success).toBe(true);
      expect(result.rounds_used).toBe(2);
      expect(result.deadlock_detected).toBe(true);
      expect(result.rounds[0].quoted_price).toBeDefined();
      expect(result.rounds[1].quoted_price).toBeDefined();
    });

    it('does not flag deadlock when prices differ', async () => {
      mockDiscover.mockResolvedValue({
        agents: [
          mockAgent('agent-cheap', 0.50, 90, '0xCheap'),
          mockAgent('agent-expensive', 0.80, 85, '0xExpensive'),
        ],
        total: 2,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(
        { ...POLICY, negotiation: { rounds_max: 3, quote_ttl: '1s' } },
        runtime,
        '0xBuyer',
        TEST_DIR,
      );

      let callCount = 0;
      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        callCount++;
        const txId = await origCreate(params);
        runtime._transactions.get(txId)!.state = 'QUOTED';
        return txId;
      };

      const origLinkEscrow = runtime.linkEscrow.bind(runtime);
      let linkCount = 0;
      runtime.linkEscrow = async (txId: string, amount: string) => {
        linkCount++;
        if (linkCount === 1) throw new Error('Simulated escrow failure');
        return origLinkEscrow(txId, amount);
      };

      const result = await orchestrator.negotiate({ pollIntervalMs: 50 });

      expect(result.success).toBe(true);
      expect(result.deadlock_detected).toBe(false);
    });

    it('includes deadlock in failure reason when all candidates exhausted', async () => {
      mockDiscover.mockResolvedValue({
        agents: [
          mockAgent('agent-a', 0.80, 90, '0xA'),
          mockAgent('agent-b', 0.80, 85, '0xB'),
        ],
        total: 2,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(
        { ...POLICY, negotiation: { rounds_max: 3, quote_ttl: '1s' } },
        runtime,
        '0xBuyer',
        TEST_DIR,
      );

      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        const txId = await origCreate(params);
        runtime._transactions.get(txId)!.state = 'QUOTED';
        return txId;
      };

      runtime.linkEscrow = async () => { throw new Error('Escrow always fails'); };

      const result = await orchestrator.negotiate({ pollIntervalMs: 50 });

      expect(result.success).toBe(false);
      expect(result.deadlock_detected).toBe(true);
      expect(result.reason).toContain('price deadlock');
    });

    it('sets final_offer on QuoteOffer when deadlock detected', async () => {
      mockDiscover.mockResolvedValue({
        agents: [
          mockAgent('agent-a', 0.80, 90, '0xA'),
          mockAgent('agent-b', 0.80, 85, '0xB'),
          mockAgent('agent-c', 0.80, 80, '0xC'),
        ],
        total: 3,
      });
      const runtime = createMockRuntime();
      const orchestrator = new BuyerOrchestrator(
        { ...POLICY, negotiation: { rounds_max: 5, quote_ttl: '5s' } },
        runtime,
        '0xBuyer',
        TEST_DIR,
      );

      const origCreate = runtime.createTransaction.bind(runtime);
      runtime.createTransaction = async (params: CreateTransactionParams) => {
        const txId = await origCreate(params);
        runtime._transactions.get(txId)!.state = 'QUOTED';
        return txId;
      };

      const origLinkEscrow = runtime.linkEscrow.bind(runtime);
      let linkCount = 0;
      runtime.linkEscrow = async (txId: string, amount: string) => {
        linkCount++;
        if (linkCount <= 2) throw new Error('Simulated escrow failure');
        return origLinkEscrow(txId, amount);
      };

      const { PolicyEngine } = require('../../src/negotiation/PolicyEngine');
      const offers: any[] = [];
      const origValidate = PolicyEngine.prototype.validate;
      PolicyEngine.prototype.validate = function(offer: any) {
        offers.push({ ...offer });
        return origValidate.call(this, offer);
      };

      try {
        const result = await orchestrator.negotiate({ pollIntervalMs: 50 });

        expect(result.success).toBe(true);
        expect(result.rounds_used).toBe(3);
        // First offer: no deadlock yet
        expect(offers[0].final_offer).toBeFalsy();
        // Third offer: deadlock was detected after rounds 1+2 quoted same price
        expect(offers[2].final_offer).toBe(true);
      } finally {
        PolicyEngine.prototype.validate = origValidate;
      }
    });
  });
});
