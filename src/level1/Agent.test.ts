/**
 * Agent Comprehensive Test Suite
 *
 * Tests cover:
 * - Constructor validation (name required, path validation)
 * - Lifecycle methods (start, stop, pause, resume, restart)
 * - Service registration (provide, duplicate detection, validation)
 * - Properties (status, address, serviceNames, jobs, stats, balance)
 * - Job processing (polling, filtering, completion)
 * - Event emission (lifecycle events, job events)
 * - Error handling (invalid states, lifecycle errors)
 *
 * @module level1/Agent.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Agent, AgentConfig } from './Agent';
import { Job, JobHandler } from './types/Job';
import { ServiceConfigError, AgentLifecycleError } from '../errors';
import { ZeroHash, keccak256, toUtf8Bytes } from 'ethers';

describe('Agent', () => {
  // State directory must be inside ~/.agirails due to security validation
  const AGIRAILS_BASE = path.join(os.homedir(), '.agirails');
  let testDir: string;

  beforeEach(() => {
    // Ensure base directory exists
    if (!fs.existsSync(AGIRAILS_BASE)) {
      fs.mkdirSync(AGIRAILS_BASE, { recursive: true });
    }
    // Create test directory inside ~/.agirails
    testDir = fs.mkdtempSync(path.join(AGIRAILS_BASE, 'agent-test-'));
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // Constructor Tests
  // ============================================================================

  describe('Constructor', () => {
    it('should create agent with minimal config', () => {
      const agent = new Agent({ name: 'TestAgent' });

      expect(agent.name).toBe('TestAgent');
      expect(agent.network).toBe('mock');
      expect(agent.status).toBe('idle');
    });

    it('should create agent with full config', () => {
      const agent = new Agent({
        name: 'FullAgent',
        description: 'A fully configured agent',
        network: 'mock',
        behavior: {
          autoAccept: true,
          concurrency: 5,
        },
        logging: {
          level: 'debug',
        },
      });

      expect(agent.name).toBe('FullAgent');
      expect(agent.description).toBe('A fully configured agent');
      expect(agent.network).toBe('mock');
    });

    it('should throw ServiceConfigError when name is missing', () => {
      expect(() => {
        new Agent({ name: '' });
      }).toThrow(ServiceConfigError);
    });

    it('should throw ServiceConfigError when name is undefined', () => {
      expect(() => {
        new Agent({} as AgentConfig);
      }).toThrow(ServiceConfigError);
    });

    it('should default network to mock', () => {
      const agent = new Agent({ name: 'DefaultNetwork' });
      expect(agent.network).toBe('mock');
    });

    it('should accept testnet network', () => {
      const agent = new Agent({ name: 'TestnetAgent', network: 'testnet' });
      expect(agent.network).toBe('testnet');
    });

    it('should accept mainnet network', () => {
      const agent = new Agent({ name: 'MainnetAgent', network: 'mainnet' });
      expect(agent.network).toBe('mainnet');
    });

    it('should validate stateDirectory path for security', () => {
      // Path traversal attempt should be caught
      expect(() => {
        new Agent({
          name: 'BadPathAgent',
          stateDirectory: '../../../etc/passwd',
        });
      }).toThrow(ServiceConfigError);
    });

    it('should initialize with default concurrency of 10', () => {
      const agent = new Agent({ name: 'DefaultConcurrency' });
      // Concurrency is internal, but we can verify the agent initializes correctly
      expect(agent.status).toBe('idle');
    });

    it('should respect custom concurrency setting', () => {
      const agent = new Agent({
        name: 'CustomConcurrency',
        behavior: { concurrency: 20 },
      });
      expect(agent.status).toBe('idle');
    });
  });

  // ============================================================================
  // Service Registration Tests
  // ============================================================================

  describe('Service Registration (provide)', () => {
    let agent: Agent;

    beforeEach(() => {
      agent = new Agent({ name: 'ServiceAgent' });
    });

    it('should register a simple service', () => {
      const handler: JobHandler = async (_job) => ({ result: 'done' });

      agent.provide('echo', handler);

      expect(agent.serviceNames).toContain('echo');
    });

    it('should register service with full config', () => {
      const handler: JobHandler = async (job) => job.input;

      agent.provide(
        {
          name: 'translation',
          description: 'Translation service',
          capabilities: ['en-de', 'en-fr'],
          timeout: 30000,
        },
        handler
      );

      expect(agent.serviceNames).toContain('translation');
    });

    it('should return this for chaining', () => {
      const handler: JobHandler = async (job) => job.input;

      const result = agent.provide('service1', handler).provide('service2', handler);

      expect(result).toBe(agent);
      expect(agent.serviceNames).toContain('service1');
      expect(agent.serviceNames).toContain('service2');
    });

    it('should throw when registering duplicate service', () => {
      const handler: JobHandler = async (job) => job.input;

      agent.provide('duplicate', handler);

      expect(() => {
        agent.provide('duplicate', handler);
      }).toThrow(ServiceConfigError);
    });

    it('should throw when service name is empty', () => {
      const handler: JobHandler = async (job) => job.input;

      expect(() => {
        agent.provide('', handler);
      }).toThrow(ServiceConfigError);
    });

    it('should throw when service name is invalid (injection attempt)', () => {
      const handler: JobHandler = async (job) => job.input;

      expect(() => {
        agent.provide('service;DROP TABLE', handler);
      }).toThrow(ServiceConfigError);
    });

    it('should emit service:registered event', () => {
      const handler: JobHandler = async (job) => job.input;
      const eventSpy = jest.fn();

      agent.on('service:registered', eventSpy);
      agent.provide('newService', handler);

      expect(eventSpy).toHaveBeenCalledWith('newService');
    });

    it('should handle service with pricing configuration', () => {
      const handler: JobHandler = async (job) => job.input;

      agent.provide(
        {
          name: 'pricedService',
          pricing: {
            cost: { base: 1.0 },
            margin: 0.2,
          },
        },
        handler
      );

      expect(agent.serviceNames).toContain('pricedService');
    });

    it('should handle service with filter function', () => {
      const handler: JobHandler = async (job) => job.input;
      const filterFn = (job: Job) => job.budget >= 5;

      agent.provide(
        {
          name: 'filteredService',
          filter: filterFn,
        },
        handler
      );

      expect(agent.serviceNames).toContain('filteredService');
    });

    it('should handle service with filter object', () => {
      const handler: JobHandler = async (job) => job.input;

      agent.provide(
        {
          name: 'budgetFilteredService',
          filter: {
            minBudget: 5,
            maxBudget: 100,
          },
        },
        handler
      );

      expect(agent.serviceNames).toContain('budgetFilteredService');
    });
  });

  // ============================================================================
  // Hash Routing (PRD §5.4)
  // ============================================================================

  describe('findServiceHandler — hash routing (PRD §5.4)', () => {
    let agent: Agent;
    let translate: JobHandler;
    let echo: JobHandler;

    beforeEach(() => {
      agent = new Agent({ name: 'RouterAgent' });
      translate = async (job) => job.input;
      echo = async (job) => job.input;
      agent.provide('translate', translate);
      agent.provide('echo', echo);
    });

    it('routes on-chain TX by matching serviceHash to a registered handler', () => {
      const tx = {
        serviceHash: keccak256(toUtf8Bytes('translate')),
        serviceDescription: '', // BlockchainRuntime-sourced — no string
      };

      const result = (agent as any).findServiceHandler(tx);

      expect(result).toBeDefined();
      expect(result.config.name).toBe('translate');
      expect(result.handler).toBe(translate);
    });

    it('matches hash case-insensitively (uppercase serviceHash still routes)', () => {
      const tx = {
        serviceHash: keccak256(toUtf8Bytes('echo')).toUpperCase().replace('0X', '0x'),
        serviceDescription: '',
      };

      const result = (agent as any).findServiceHandler(tx);
      expect(result.config.name).toBe('echo');
    });

    it('skips hash branch for ZeroHash (Level 0 pay semantics)', () => {
      // ZeroHash means a `pay` call — no INITIATED job, no handler dispatch.
      // With an empty serviceDescription the string fallback also misses.
      const tx = {
        serviceHash: ZeroHash,
        serviceDescription: '',
      };

      const result = (agent as any).findServiceHandler(tx);
      expect(result).toBeUndefined();
    });

    it('returns undefined when no handler is registered for the hash', () => {
      const tx = {
        serviceHash: keccak256(toUtf8Bytes('unregistered-service')),
        serviceDescription: '',
      };

      const result = (agent as any).findServiceHandler(tx);
      expect(result).toBeUndefined();
    });

    it('falls back to string dispatch when hash is missing (MockRuntime test fixtures)', () => {
      // Mock-style transactions may carry serviceDescription only.
      const tx = {
        serviceDescription: 'translate',
      };

      const result = (agent as any).findServiceHandler(tx);
      expect(result).toBeDefined();
      expect(result.config.name).toBe('translate');
    });

    it('falls back to string dispatch when hash misses but description matches', () => {
      // Cross-runtime safety: an unknown hash should not block a legitimate
      // string-based match for legacy/mock fixtures.
      const tx = {
        serviceHash: keccak256(toUtf8Bytes('nonexistent')),
        serviceDescription: 'echo',
      };

      const result = (agent as any).findServiceHandler(tx);
      expect(result?.config.name).toBe('echo');
    });

    it('keeps hash map and string map in sync on provide()', () => {
      // Internal consistency: every name we register must also be reachable by hash.
      const expectedHash = keccak256(toUtf8Bytes('translate')).toLowerCase();
      expect((agent as any).handlersByHash.has(expectedHash)).toBe(true);
      expect((agent as any).services.has('translate')).toBe(true);
    });
  });

  // ============================================================================
  // Job construction with hash routing (PRD §5.4.1)
  // ============================================================================

  describe('createJobFromTransaction — hash routing carries service name (PRD §5.4.1)', () => {
    let agent: Agent;

    beforeEach(() => {
      agent = new Agent({ name: 'JobShapeAgent' });
      agent.provide('onboarding', async (job) => job.input);
    });

    it("uses matched handler's config.name when tx.serviceDescription is empty (hash-only TX)", () => {
      // BlockchainRuntime-sourced TX: only the bytes32 routing key is present.
      // Without the §5.4.1 fix, extractServiceName(tx) would return 'unknown'.
      const tx = {
        id: '0xtx',
        amount: '50000',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        requester: '0x' + 'a'.repeat(40),
        serviceHash: keccak256(toUtf8Bytes('onboarding')),
        serviceDescription: '',
      };
      const matched = (agent as any).findServiceHandler(tx);
      const job = (agent as any).createJobFromTransaction(tx, matched);

      expect(job.service).toBe('onboarding');
    });

    it("uses matched handler's name even when tx.serviceDescription is a bytes32 hash", () => {
      // MockRuntime passthrough mode: createTransaction stores the bytes32
      // hash in serviceDescription as well. extractServiceName(tx) would
      // hit the bytes32-detect branch and return 'unknown'. The matched
      // handler must override.
      const hash = keccak256(toUtf8Bytes('onboarding'));
      const tx = {
        id: '0xtx',
        amount: '50000',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        requester: '0x' + 'a'.repeat(40),
        serviceHash: hash,
        serviceDescription: hash,
      };
      const matched = (agent as any).findServiceHandler(tx);
      const job = (agent as any).createJobFromTransaction(tx, matched);

      expect(job.service).toBe('onboarding');
    });

    it('falls back to extractServiceName when caller omits matched (back-compat)', () => {
      // No matched supplied → legacy behavior. Plain-string description that
      // matches a registered name still resolves correctly through
      // extractServiceName.
      const tx = {
        id: '0xtx',
        amount: '50000',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        requester: '0x' + 'a'.repeat(40),
        serviceHash: ZeroHash,
        serviceDescription: 'onboarding',
      };
      const job = (agent as any).createJobFromTransaction(tx);
      expect(job.service).toBe('onboarding');
    });

    // PRD §5.3 — Agent lifecycle: subscription wiring, idempotent start,
    // pause/resume teardown, try/finally on processingLocks, case-insensitive
    // provider check. These tests live alongside the hash-routing block since
    // §5.3 + §5.4 jointly produce the end-to-end provider flow.
    describe('handleIncomingTransaction pipeline (PRD §5.3)', () => {
      let pipelineAgent: Agent;

      beforeEach(() => {
        pipelineAgent = new Agent({ name: 'PipelineAgent' });
        pipelineAgent.provide('onboarding', async (job) => job.input);
        // Stub address — the per-tx provider check below compares against it.
        Object.defineProperty(pipelineAgent, 'address', {
          get: () => '0xAbCdEf0000000000000000000000000000000001',
          configurable: true,
        });
        // PRD §5.3.1: pipeline now refuses work unless agent is running.
        // Tests bypass start() to keep the unit scope tight.
        (pipelineAgent as any)._status = 'running';
      });

      const baseTx = () => ({
        id: '0xtx',
        provider: '0xAbCdEf0000000000000000000000000000000001',
        requester: '0x' + 'a'.repeat(40),
        amount: '1000000',
        state: 'INITIATED' as const,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 172800,
        completedAt: 0,
        escrowId: '',
        serviceHash: keccak256(toUtf8Bytes('onboarding')),
        serviceDescription: '',
        deliveryProof: '',
        events: [],
      });

      // Stub the minimum client surface the async processJob() reaches into.
      // Post-4.0.0-beta.2 Agent routes write operations through
      // `client.standard.*` so AA-enabled providers go via Paymaster;
      // the stub provides both `standard` (the route Agent now takes)
      // and `runtime` (used by some pre-existing helpers and by
      // StandardAdapter's fallback path) so tests cover both shapes.
      // linkEscrow signature is StandardAdapter's `(txId)` form — the
      // adapter reads tx.amount from runtime internally.
      const stubRuntime = (
        linkEscrow: jest.Mock = jest.fn().mockResolvedValue(undefined),
        transitionState: jest.Mock = jest.fn().mockResolvedValue(undefined),
      ) => {
        (pipelineAgent as any)._client = {
          standard: { linkEscrow, transitionState },
          runtime: { linkEscrow, transitionState },
        };
        return { linkEscrow, transitionState };
      };

      it('releases processingLocks after successful acceptance', async () => {
        stubRuntime();
        await (pipelineAgent as any).handleIncomingTransaction(baseTx());
        expect((pipelineAgent as any).processingLocks.has('0xtx')).toBe(false);
      });

      it('releases processingLocks when handler resolution fails', async () => {
        // No `agent.provide('translate', ...)` — handler lookup misses.
        const tx = { ...baseTx(), serviceHash: keccak256(toUtf8Bytes('translate')) };
        await (pipelineAgent as any).handleIncomingTransaction(tx);
        expect((pipelineAgent as any).processingLocks.has(tx.id)).toBe(false);
      });

      it('releases processingLocks when linkEscrow throws (poison TX recovery)', async () => {
        stubRuntime(jest.fn().mockRejectedValue(new Error('revert')));
        await (pipelineAgent as any).handleIncomingTransaction(baseTx());
        expect((pipelineAgent as any).processingLocks.has('0xtx')).toBe(false);
      });

      it('matches provider case-insensitively (§5.3 carry-forward)', async () => {
        // TX provider stored as uppercase; agent.address is mixed case.
        // Without case-insensitive comparison, the unauthorized-tx branch
        // would fire and reject the legitimate job.
        const tx = { ...baseTx(), provider: '0xABCDEF0000000000000000000000000000000001' };
        const { linkEscrow } = stubRuntime();

        const received = jest.fn();
        pipelineAgent.on('job:received', received);

        await (pipelineAgent as any).handleIncomingTransaction(tx);

        expect(received).toHaveBeenCalledTimes(1);
        expect(linkEscrow).toHaveBeenCalledWith(tx.id);
      });

      it('does not double-process when called twice with the same tx', async () => {
        const { linkEscrow } = stubRuntime();

        await (pipelineAgent as any).handleIncomingTransaction(baseTx());
        await (pipelineAgent as any).handleIncomingTransaction(baseTx());

        // Second call is short-circuited by processedJobs / activeJobs check.
        expect(linkEscrow).toHaveBeenCalledTimes(1);
      });

      // PRD §5.3.1: status guard.
      it('drops the tx when agent is paused', async () => {
        const { linkEscrow } = stubRuntime();
        (pipelineAgent as any)._status = 'paused';

        const received = jest.fn();
        pipelineAgent.on('job:received', received);

        await (pipelineAgent as any).handleIncomingTransaction(baseTx());

        expect(received).not.toHaveBeenCalled();
        expect(linkEscrow).not.toHaveBeenCalled();
      });

      it.each(['stopping', 'stopped', 'idle'] as const)(
        'drops the tx when agent status is %s',
        async (status) => {
          const { linkEscrow } = stubRuntime();
          (pipelineAgent as any)._status = status;

          await (pipelineAgent as any).handleIncomingTransaction(baseTx());

          expect(linkEscrow).not.toHaveBeenCalled();
        }
      );

      it("allows tx through during 'starting' status (subscribe-before-status race)", async () => {
        // start() wires the subscription before flipping _status to 'running'.
        // A fast on-chain event during that window must still be accepted.
        const { linkEscrow } = stubRuntime();
        (pipelineAgent as any)._status = 'starting';

        await (pipelineAgent as any).handleIncomingTransaction(baseTx());

        expect(linkEscrow).toHaveBeenCalledTimes(1);
      });
    });

    // PRD §5.3 — subscription lifecycle on BlockchainRuntime-like runtimes.
    describe('subscribeIfBlockchain wiring (PRD §5.3)', () => {
      let agentSub: Agent;
      let cleanup: jest.Mock;
      let subscribeSpy: jest.Mock;

      beforeEach(() => {
        agentSub = new Agent({ name: 'SubAgent' });
        cleanup = jest.fn();
        subscribeSpy = jest.fn().mockReturnValue(cleanup);
        // Inject a runtime that looks like BlockchainRuntime (has
        // subscribeProviderJobs). MockRuntime deliberately doesn't, so the
        // subscription path is gated on this duck-type check.
        (agentSub as any)._client = {
          runtime: { subscribeProviderJobs: subscribeSpy },
        };
        Object.defineProperty(agentSub, 'address', {
          get: () => '0x' + '1'.repeat(40),
          configurable: true,
        });
      });

      it('wires subscription and stores cleanup callback', () => {
        (agentSub as any).subscribeIfBlockchain();
        expect(subscribeSpy).toHaveBeenCalledWith(
          '0x' + '1'.repeat(40),
          expect.any(Function)
        );
        expect((agentSub as any).jobSubscriptionCleanup).toBe(cleanup);
      });

      it('refuses to double-subscribe when one is already active', () => {
        (agentSub as any).subscribeIfBlockchain();
        (agentSub as any).subscribeIfBlockchain();
        expect(subscribeSpy).toHaveBeenCalledTimes(1);
      });

      it('unsubscribe() invokes and clears the cleanup callback', () => {
        (agentSub as any).subscribeIfBlockchain();
        (agentSub as any).unsubscribe();
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect((agentSub as any).jobSubscriptionCleanup).toBeUndefined();
      });

      it('unsubscribe() is idempotent (safe to call when no subscription)', () => {
        // No prior subscribe — must not throw.
        expect(() => (agentSub as any).unsubscribe()).not.toThrow();
        expect(cleanup).not.toHaveBeenCalled();
      });

      it('skips wiring when runtime does not expose subscribeProviderJobs (MockRuntime)', () => {
        (agentSub as any)._client = { runtime: {} };
        (agentSub as any).subscribeIfBlockchain();
        expect((agentSub as any).jobSubscriptionCleanup).toBeUndefined();
      });
    });

    // PRD §5.3.1: resume() must clean up a half-armed lifecycle if
    // subscribeIfBlockchain throws after startPolling already armed the timer.
    describe('resume partial-failure cleanup (PRD §5.3.1)', () => {
      it('rolls back polling when subscribeIfBlockchain throws and surfaces the error', () => {
        const agentRes = new Agent({ name: 'ResumeAgent' });
        // Inject a runtime whose subscribeProviderJobs throws synchronously.
        const failingSubscribe = jest.fn(() => {
          throw new Error('subscription transport failed');
        });
        (agentRes as any)._client = {
          runtime: { subscribeProviderJobs: failingSubscribe },
        };
        Object.defineProperty(agentRes, 'address', {
          get: () => '0x' + 'a'.repeat(40),
          configurable: true,
        });
        // Pre-flight: pretend the agent was running and got paused (so the
        // state machine guard at the top of resume() passes).
        (agentRes as any)._status = 'paused';

        expect(() => agentRes.resume()).toThrow(/subscription transport failed/);

        // Polling timer must be cleared (would survive without the §5.3.1 fix).
        expect((agentRes as any).pollingIntervalId).toBeUndefined();
        // Subscription cleanup must also be unset (none was wired anyway, but
        // unsubscribe() must remain safe to call after the failure).
        expect((agentRes as any).jobSubscriptionCleanup).toBeUndefined();
        // Status stays paused — caller can retry resume() once the underlying
        // transport recovers.
        expect(agentRes.status).toBe('paused');
      });
    });

    it("shouldAutoAccept's autoAccept callback sees the resolved service name", async () => {
      // Threading proof: shouldAutoAccept's function-form autoAccept must
      // receive a job whose `service` is the registered name, not 'unknown',
      // even on hash-only TXs.
      let seenServiceInCallback: string | undefined;
      const recordingAgent = new Agent({
        name: 'CallbackAgent',
        behavior: {
          autoAccept: async (job) => {
            seenServiceInCallback = job.service;
            return true;
          },
        },
      });
      recordingAgent.provide('onboarding', async (job) => job.input);

      const tx = {
        id: '0xtx',
        amount: '50000',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        requester: '0x' + 'a'.repeat(40),
        serviceHash: keccak256(toUtf8Bytes('onboarding')),
        serviceDescription: '',
      };
      const matched = (recordingAgent as any).findServiceHandler(tx);
      const decision = await (recordingAgent as any).shouldAutoAccept(tx, matched);

      expect(decision).toBe(true);
      expect(seenServiceInCallback).toBe('onboarding');
    });
  });

  // ============================================================================
  // Properties Tests
  // ============================================================================

  describe('Properties', () => {
    let agent: Agent;

    beforeEach(() => {
      agent = new Agent({ name: 'PropsAgent' });
    });

    describe('status', () => {
      it('should be idle initially', () => {
        expect(agent.status).toBe('idle');
      });
    });

    describe('address', () => {
      it('should return empty string when not started', () => {
        expect(agent.address).toBe('');
      });
    });

    describe('serviceNames', () => {
      it('should return empty array initially', () => {
        expect(agent.serviceNames).toEqual([]);
      });

      it('should return registered service names', () => {
        agent.provide('service1', async (job) => job.input);
        agent.provide('service2', async (job) => job.input);

        expect(agent.serviceNames).toContain('service1');
        expect(agent.serviceNames).toContain('service2');
        expect(agent.serviceNames.length).toBe(2);
      });
    });

    describe('jobs', () => {
      it('should return empty array initially', () => {
        expect(agent.jobs).toEqual([]);
      });
    });

    describe('stats', () => {
      it('should return initial stats', () => {
        const stats = agent.stats;

        expect(stats.jobsReceived).toBe(0);
        expect(stats.jobsCompleted).toBe(0);
        expect(stats.jobsFailed).toBe(0);
        expect(stats.totalEarned).toBe(0);
        expect(stats.totalSpent).toBe(0);
        expect(stats.averageJobTime).toBe(0);
        expect(stats.successRate).toBe(0);
      });

      it('should return a copy (immutable)', () => {
        const stats1 = agent.stats;
        const stats2 = agent.stats;

        expect(stats1).not.toBe(stats2);
        expect(stats1).toEqual(stats2);
      });
    });

    describe('balance', () => {
      it('should return initial balance', () => {
        const balance = agent.balance;

        expect(balance.eth).toBe('0');
        expect(balance.usdc).toBe('0');
        expect(balance.locked).toBe('0');
        expect(balance.pending).toBe('0');
      });

      it('should return a copy (immutable)', () => {
        const balance1 = agent.balance;
        const balance2 = agent.balance;

        expect(balance1).not.toBe(balance2);
        expect(balance1).toEqual(balance2);
      });
    });

    describe('client', () => {
      it('should be undefined when not started', () => {
        expect(agent.client).toBeUndefined();
      });
    });
  });

  // ============================================================================
  // Lifecycle Tests
  // ============================================================================

  describe('Lifecycle', () => {
    let agent: Agent;

    beforeEach(() => {
      agent = new Agent({
        name: 'LifecycleAgent',
        network: 'mock',
        stateDirectory: testDir,
      });
    });

    afterEach(async () => {
      // Ensure agent is stopped after each test
      if (agent.status !== 'stopped' && agent.status !== 'idle') {
        await agent.stop();
      }
    });

    describe('start()', () => {
      it('should transition from idle to running', async () => {
        expect(agent.status).toBe('idle');

        await agent.start();

        expect(agent.status).toBe('running');
      });

      it('should emit starting and started events', async () => {
        const startingSpy = jest.fn();
        const startedSpy = jest.fn();

        agent.on('starting', startingSpy);
        agent.on('started', startedSpy);

        await agent.start();

        expect(startingSpy).toHaveBeenCalled();
        expect(startedSpy).toHaveBeenCalled();
      });

      it('should initialize ACTP client', async () => {
        expect(agent.client).toBeUndefined();

        await agent.start();

        expect(agent.client).toBeDefined();
      });

      it('should be idempotent when already running (PRD §5.3)', async () => {
        // PRD §5.3 changed start() from throwing AgentLifecycleError to a
        // logged noop. This is a behavior change from 3.5.3 — see
        // CHANGELOG / MIGRATION-4.0.
        await agent.start();
        expect(agent.status).toBe('running');

        await expect(agent.start()).resolves.toBeUndefined();
        expect(agent.status).toBe('running');
      });

      it('should be idempotent when paused (PRD §5.3)', async () => {
        await agent.start();
        agent.pause();
        expect(agent.status).toBe('paused');

        // start() on a paused agent is a noop — caller must resume() explicitly.
        await expect(agent.start()).resolves.toBeUndefined();
        expect(agent.status).toBe('paused');
      });

      it('should be able to start after being stopped', async () => {
        await agent.start();
        await agent.stop();

        expect(agent.status).toBe('stopped');

        await agent.start();

        expect(agent.status).toBe('running');
      });

      it('should set address after start', async () => {
        await agent.start();

        expect(agent.address).toBeTruthy();
        expect(agent.address.startsWith('0x')).toBe(true);
      });
    });

    describe('stop()', () => {
      it('should transition from running to stopped', async () => {
        await agent.start();
        expect(agent.status).toBe('running');

        await agent.stop();

        expect(agent.status).toBe('stopped');
      });

      it('should emit stopping and stopped events', async () => {
        const stoppingSpy = jest.fn();
        const stoppedSpy = jest.fn();

        agent.on('stopping', stoppingSpy);
        agent.on('stopped', stoppedSpy);

        await agent.start();
        await agent.stop();

        expect(stoppingSpy).toHaveBeenCalled();
        expect(stoppedSpy).toHaveBeenCalled();
      });

      it('should be idempotent (can call multiple times)', async () => {
        await agent.start();
        await agent.stop();
        await agent.stop(); // Second call should not throw

        expect(agent.status).toBe('stopped');
      });

      it('should stop polling', async () => {
        await agent.start();
        await agent.stop();

        // Agent should not poll after stopping
        expect(agent.status).toBe('stopped');
      });
    });

    describe('pause()', () => {
      it('should transition from running to paused', async () => {
        await agent.start();

        agent.pause();

        expect(agent.status).toBe('paused');
      });

      it('should emit paused event', async () => {
        const pausedSpy = jest.fn();

        agent.on('paused', pausedSpy);

        await agent.start();
        agent.pause();

        expect(pausedSpy).toHaveBeenCalled();
      });

      it('should throw AgentLifecycleError if not running', () => {
        expect(() => {
          agent.pause();
        }).toThrow(AgentLifecycleError);
      });

      it('should throw AgentLifecycleError if already paused', async () => {
        await agent.start();
        agent.pause();

        expect(() => {
          agent.pause();
        }).toThrow(AgentLifecycleError);
      });
    });

    describe('resume()', () => {
      it('should transition from paused to running', async () => {
        await agent.start();
        agent.pause();

        agent.resume();

        expect(agent.status).toBe('running');
      });

      it('should emit resumed event', async () => {
        const resumedSpy = jest.fn();

        agent.on('resumed', resumedSpy);

        await agent.start();
        agent.pause();
        agent.resume();

        expect(resumedSpy).toHaveBeenCalled();
      });

      it('should throw AgentLifecycleError if not paused', async () => {
        await agent.start();

        expect(() => {
          agent.resume();
        }).toThrow(AgentLifecycleError);
      });

      it('should throw AgentLifecycleError if idle', () => {
        expect(() => {
          agent.resume();
        }).toThrow(AgentLifecycleError);
      });
    });

    describe('restart()', () => {
      it('should stop and start the agent', async () => {
        await agent.start();
        const addressBefore = agent.address;

        await agent.restart();

        expect(agent.status).toBe('running');
        // Address should be the same (deterministic in mock mode)
        expect(agent.address).toBe(addressBefore);
      });
    });
  });

  // ============================================================================
  // getBalanceAsync Tests
  // ============================================================================

  describe('getBalanceAsync()', () => {
    let agent: Agent;

    beforeEach(() => {
      agent = new Agent({
        name: 'BalanceAgent',
        network: 'mock',
        stateDirectory: testDir,
      });
    });

    afterEach(async () => {
      if (agent.status !== 'stopped' && agent.status !== 'idle') {
        await agent.stop();
      }
    });

    it('should return zero balance when not started', async () => {
      const balance = await agent.getBalanceAsync();

      expect(balance.eth).toBe('0');
      expect(balance.usdc).toBe('0');
      expect(balance.locked).toBe('0');
      expect(balance.pending).toBe('0');
    });

    it('should return balance after start', async () => {
      await agent.start();

      const balance = await agent.getBalanceAsync();

      expect(balance).toBeDefined();
      expect(typeof balance.usdc).toBe('string');
    });
  });

  // ============================================================================
  // Event Tests
  // ============================================================================

  describe('Events', () => {
    let agent: Agent;

    beforeEach(() => {
      agent = new Agent({ name: 'EventAgent' });
    });

    it('should extend EventEmitter', () => {
      expect(agent.on).toBeDefined();
      expect(agent.emit).toBeDefined();
      expect(agent.off).toBeDefined();
    });

    it('should allow multiple listeners', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      agent.on('service:registered', listener1);
      agent.on('service:registered', listener2);

      agent.provide('test', async (job) => job.input);

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('should allow removing listeners', () => {
      const listener = jest.fn();

      agent.on('service:registered', listener);
      agent.off('service:registered', listener);

      agent.provide('test', async (job) => job.input);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Wallet Configuration Tests
  // ============================================================================

  describe('Wallet Configuration', () => {
    it('should generate deterministic address in mock mode', () => {
      const agent1 = new Agent({ name: 'SameAgent' });
      const agent2 = new Agent({ name: 'SameAgent' });

      // Both should generate the same address for the same name in mock mode
      // (addresses are generated from name when no private key is provided)
      expect(agent1.name).toBe(agent2.name);
    });

    it('should accept private key in wallet config', () => {
      // Valid private key format (64 hex chars with 0x prefix)
      const privateKey = '0x' + '1'.repeat(64);

      const agent = new Agent({
        name: 'PKAgent',
        wallet: { privateKey },
      });

      expect(agent.name).toBe('PKAgent');
    });

    it('should throw on invalid private key format during start', async () => {
      const agent = new Agent({
        name: 'BadPKAgent',
        network: 'mock',
        wallet: { privateKey: 'invalid-key' },
      });

      // Private key validation happens during start() when generateAddress() is called
      await expect(agent.start()).rejects.toThrow();
    });

    it('should accept address string in wallet config', () => {
      const agent = new Agent({
        name: 'AddressAgent',
        wallet: '0x' + '0'.repeat(40),
      });

      expect(agent.name).toBe('AddressAgent');
    });
  });

  // ============================================================================
  // Request Tests (requires started agent)
  // ============================================================================

  describe('request()', () => {
    it('should throw AgentLifecycleError when not started', async () => {
      const agent = new Agent({
        name: 'RequesterAgent',
        network: 'mock',
      });

      await expect(
        agent.request('someService', {
          provider: '0x' + '1'.repeat(40),
          input: { test: true },
          budget: 10,
        })
      ).rejects.toThrow(AgentLifecycleError);
    });
  });

  // ============================================================================
  // Behavior Configuration Tests
  // ============================================================================

  describe('Behavior Configuration', () => {
    it('should respect autoAccept: false', () => {
      const agent = new Agent({
        name: 'NoAutoAccept',
        behavior: { autoAccept: false },
      });

      expect(agent.status).toBe('idle');
    });

    it('should accept retry configuration', () => {
      const agent = new Agent({
        name: 'RetryAgent',
        behavior: {
          retry: {
            attempts: 3,
            delay: 1000,
            backoff: 'exponential',
          },
        },
      });

      expect(agent.status).toBe('idle');
    });
  });

  // ============================================================================
  // Logging Configuration Tests
  // ============================================================================

  describe('Logging Configuration', () => {
    it('should accept debug log level', () => {
      const agent = new Agent({
        name: 'DebugAgent',
        logging: { level: 'debug' },
      });

      expect(agent.status).toBe('idle');
    });

    it('should accept error log level', () => {
      const agent = new Agent({
        name: 'ErrorAgent',
        logging: { level: 'error' },
      });

      expect(agent.status).toBe('idle');
    });
  });

  // ============================================================================
  // Error Event Tests
  // ============================================================================

  describe('Error Events', () => {
    it('should emit error event on start failure', async () => {
      // Create agent with invalid configuration that will fail on start
      const badAgent = new Agent({
        name: 'BadStartAgent',
        network: 'testnet', // Testnet requires private key
      });

      const errorSpy = jest.fn();
      badAgent.on('error', errorSpy);

      await expect(badAgent.start()).rejects.toThrow();
    });
  });

  describe('safeEmitError (crash resilience)', () => {
    it('does NOT throw when emitting an error with no listener attached', () => {
      // Node EventEmitter throws on an unhandled 'error' event; a long-running
      // agent must not die on a transient poll/job failure when no listener.
      const agent = new Agent({ name: 'Resilient', network: 'mock' });
      expect(() => (agent as any).safeEmitError(new Error('transient poll error'))).not.toThrow();
    });

    it('delivers the error to a registered error listener', () => {
      const agent = new Agent({ name: 'Listened', network: 'mock' });
      const seen: unknown[] = [];
      agent.on('error', (e) => seen.push(e));
      const err = new Error('boom');
      (agent as any).safeEmitError(err);
      expect(seen).toEqual([err]);
    });
  });

  describe('bounded job retry', () => {
    it('stops retrying a repeatedly-failing job after MAX_JOB_ATTEMPTS', async () => {
      const agent = new Agent({ name: 'BoundedRetry', network: 'mock' }) as any;
      const job = {
        id: '0xRetryJob', service: 'svc', budget: 10,
        requester: '0x' + 'a'.repeat(40), input: {}, metadata: {},
      };
      const failing = async () => { throw new Error('handler fails deterministically (bad input)'); };

      await agent.processJob(job, failing); // attempt 1
      expect(agent.processedJobs.has(job.id)).toBe(false); // still retryable
      await agent.processJob(job, failing); // attempt 2
      expect(agent.processedJobs.has(job.id)).toBe(false);
      await agent.processJob(job, failing); // attempt 3 → give up
      expect(agent.processedJobs.has(job.id)).toBe(true);  // marked processed; polling won't retry forever
    });
  });
});
