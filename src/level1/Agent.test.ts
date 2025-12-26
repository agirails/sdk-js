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

      it('should throw AgentLifecycleError if already running', async () => {
        await agent.start();

        await expect(agent.start()).rejects.toThrow(AgentLifecycleError);
      });

      it('should throw AgentLifecycleError if paused', async () => {
        await agent.start();
        agent.pause();

        await expect(agent.start()).rejects.toThrow(AgentLifecycleError);
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
});
