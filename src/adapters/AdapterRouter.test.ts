/**
 * AdapterRouter tests
 *
 * Tests the intelligent adapter selection logic with guard-rails.
 */

import { AdapterRouter } from './AdapterRouter';
import { AdapterRegistry } from './AdapterRegistry';
import { IAdapter, TransactionStatus } from './IAdapter';
import { AdapterMetadata, UnifiedPayParams, UnifiedPayResult } from '../types/adapter';
import { ValidationError } from './BaseAdapter';

// ============================================================================
// Mock Adapter Implementation
// ============================================================================

class MockAdapter implements IAdapter {
  constructor(
    public readonly metadata: AdapterMetadata,
    private _canHandle: (params: UnifiedPayParams) => boolean = () => true
  ) {}

  async pay(params: UnifiedPayParams): Promise<UnifiedPayResult> {
    return {
      txId: '0x' + '1'.repeat(64),
      escrowId: '0x' + '1'.repeat(64),
      adapter: this.metadata.id,
      state: 'COMMITTED',
      success: true,
      amount: String(params.amount) + ' USDC',
      releaseRequired: true,
      provider: params.to.toLowerCase(),
      requester: '0x' + '2'.repeat(40),
      deadline: new Date().toISOString(),
    };
  }

  canHandle(params: UnifiedPayParams): boolean {
    return this._canHandle(params);
  }

  validate(params: UnifiedPayParams): void {
    if (!params.to) {
      throw new ValidationError('Missing "to" parameter');
    }
  }

  async getStatus(_txId: string): Promise<TransactionStatus> {
    return {
      state: 'COMMITTED',
      canStartWork: true,
      canDeliver: false,
      canRelease: false,
      canDispute: false,
      amount: '100.00 USDC',
      provider: '0x' + '3'.repeat(40),
      requester: '0x' + '4'.repeat(40),
    };
  }

  async startWork(_txId: string): Promise<void> {}
  async deliver(_txId: string, _proof: string): Promise<void> {}
  async release(_escrowId: string): Promise<void> {}
}

// ============================================================================
// Test Fixtures
// ============================================================================

const basicMetadata: AdapterMetadata = {
  id: 'basic',
  name: 'Basic Adapter',
  usesEscrow: true,
  supportsDisputes: true,
  requiresIdentity: false,
  settlementMode: 'explicit',
  priority: 50,
};

const standardMetadata: AdapterMetadata = {
  id: 'standard',
  name: 'Standard Adapter',
  usesEscrow: true,
  supportsDisputes: true,
  requiresIdentity: false,
  settlementMode: 'explicit',
  priority: 60,
};

const x402Metadata: AdapterMetadata = {
  id: 'x402',
  name: 'X402 Adapter',
  usesEscrow: false,
  supportsDisputes: false,
  requiresIdentity: false,
  settlementMode: 'explicit',
  priority: 70,
};

const erc8004Metadata: AdapterMetadata = {
  id: 'erc8004',
  name: 'ERC-8004 Adapter',
  usesEscrow: true,
  supportsDisputes: true,
  requiresIdentity: true,
  supportedIdentityTypes: ['erc8004'],
  settlementMode: 'explicit',
  priority: 65,
};

const VALID_ADDRESS = '0x' + '1'.repeat(40);

// ============================================================================
// Tests
// ============================================================================

describe('AdapterRouter', () => {
  let registry: AdapterRegistry;
  let router: AdapterRouter;
  let basicAdapter: MockAdapter;
  let standardAdapter: MockAdapter;

  beforeEach(() => {
    registry = new AdapterRegistry();
    basicAdapter = new MockAdapter(basicMetadata);
    standardAdapter = new MockAdapter(standardMetadata);
    registry.register(basicAdapter);
    registry.register(standardAdapter);
    router = new AdapterRouter(registry);
  });

  describe('select()', () => {
    it('selects highest priority adapter by default', () => {
      const params: UnifiedPayParams = { to: VALID_ADDRESS, amount: '100' };
      const adapter = router.select(params);
      // Standard has higher priority (60) than basic (50)
      expect(adapter.metadata.id).toBe('standard');
    });

    it('selects BasicAdapter when only basic is available', () => {
      const basicOnlyRegistry = new AdapterRegistry();
      basicOnlyRegistry.register(new MockAdapter(basicMetadata));
      const basicOnlyRouter = new AdapterRouter(basicOnlyRegistry);

      const params: UnifiedPayParams = { to: VALID_ADDRESS, amount: '100' };
      const adapter = basicOnlyRouter.select(params);
      expect(adapter.metadata.id).toBe('basic');
    });

    it('selects StandardAdapter when escrow is required', () => {
      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        metadata: { requiresEscrow: true },
      };
      const adapter = router.select(params);
      expect(adapter.metadata.id).toBe('standard');
    });

    it('selects StandardAdapter when dispute resolution is required', () => {
      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        metadata: { requiresDispute: true },
      };
      const adapter = router.select(params);
      expect(adapter.metadata.id).toBe('standard');
    });

    it('throws when requiresEscrow but no escrow-capable adapter available', () => {
      // Create registry with only non-escrow adapter (like x402)
      const noEscrowMetadata: AdapterMetadata = {
        id: 'no-escrow',
        name: 'No Escrow Adapter',
        usesEscrow: false,
        supportsDisputes: false,
        requiresIdentity: false,
        settlementMode: 'explicit',
        priority: 50,
      };
      const noEscrowRegistry = new AdapterRegistry();
      noEscrowRegistry.register(new MockAdapter(noEscrowMetadata));
      const noEscrowRouter = new AdapterRouter(noEscrowRegistry);

      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        metadata: { requiresEscrow: true },
      };
      expect(() => noEscrowRouter.select(params)).toThrow(/required capabilities.*escrow/);
    });

    it('throws when requiresDispute but no dispute-capable adapter available', () => {
      // Create registry with only non-dispute adapter
      const noDisputeMetadata: AdapterMetadata = {
        id: 'no-dispute',
        name: 'No Dispute Adapter',
        usesEscrow: true,
        supportsDisputes: false,
        requiresIdentity: false,
        settlementMode: 'explicit',
        priority: 50,
      };
      const noDisputeRegistry = new AdapterRegistry();
      noDisputeRegistry.register(new MockAdapter(noDisputeMetadata));
      const noDisputeRouter = new AdapterRouter(noDisputeRegistry);

      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        metadata: { requiresDispute: true },
      };
      expect(() => noDisputeRouter.select(params)).toThrow(/required capabilities.*dispute/);
    });

    it('finds alternative escrow adapter when standard not available', () => {
      // Create registry without 'standard' but with another escrow adapter
      const altEscrowMetadata: AdapterMetadata = {
        id: 'alt-escrow',
        name: 'Alternative Escrow Adapter',
        usesEscrow: true,
        supportsDisputes: true,
        requiresIdentity: false,
        settlementMode: 'explicit',
        priority: 40,
      };
      const altRegistry = new AdapterRegistry();
      altRegistry.register(new MockAdapter(altEscrowMetadata));
      const altRouter = new AdapterRouter(altRegistry);

      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        metadata: { requiresEscrow: true },
      };
      const adapter = altRouter.select(params);
      expect(adapter.metadata.id).toBe('alt-escrow');
      expect(adapter.metadata.usesEscrow).toBe(true);
    });

    it('respects preferredAdapter metadata', () => {
      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        metadata: { preferredAdapter: 'basic' },
      };
      const adapter = router.select(params);
      expect(adapter.metadata.id).toBe('basic');
    });

    it('throws for unknown preferredAdapter', () => {
      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        metadata: { preferredAdapter: 'nonexistent' },
      };
      expect(() => router.select(params)).toThrow(/not found/);
    });

    it('selects x402 adapter for HTTP endpoints when available', () => {
      const x402Adapter = new MockAdapter(x402Metadata, (p) =>
        p.to.startsWith('http')
      );
      registry.register(x402Adapter);

      const params: UnifiedPayParams = {
        to: 'https://api.example.com/pay',
        amount: '100',
      };
      const adapter = router.select(params);
      expect(adapter.metadata.id).toBe('x402');
    });

    it('falls back when x402 cannot handle HTTP endpoint', () => {
      const x402Adapter = new MockAdapter(x402Metadata, () => false);
      registry.register(x402Adapter);

      const params: UnifiedPayParams = {
        to: 'https://api.example.com/pay',
        amount: '100',
      };
      const adapter = router.select(params);
      // Should fall back to standard (highest priority that can handle)
      expect(adapter.metadata.id).toBe('standard');
    });

    it('selects ERC-8004 adapter when identity type matches', () => {
      const erc8004Adapter = new MockAdapter(erc8004Metadata);
      registry.register(erc8004Adapter);

      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        metadata: {
          identity: { type: 'erc8004', value: 'agent123' },
        },
      };
      const adapter = router.select(params);
      expect(adapter.metadata.id).toBe('erc8004');
    });
  });

  describe('validation', () => {
    it('throws for missing "to" parameter', () => {
      const params = { amount: '100' } as UnifiedPayParams;
      expect(() => router.select(params)).toThrow(/Invalid payment params/);
    });

    it('throws for empty "to" parameter', () => {
      const params: UnifiedPayParams = { to: '', amount: '100' };
      expect(() => router.select(params)).toThrow(/Invalid payment params/);
    });

    it('throws for negative amount', () => {
      const params: UnifiedPayParams = { to: VALID_ADDRESS, amount: -100 };
      expect(() => router.select(params)).toThrow(/Invalid payment params/);
    });

    it('throws for path traversal in "to"', () => {
      const params: UnifiedPayParams = { to: '../etc/passwd', amount: '100' };
      expect(() => router.select(params)).toThrow(/path traversal/);
    });

    it('throws for HTML/script characters in "to"', () => {
      const params: UnifiedPayParams = { to: '<script>evil()</script>', amount: '100' };
      expect(() => router.select(params)).toThrow(/HTML\/script/);
    });

    it('throws for null bytes in "to"', () => {
      const params: UnifiedPayParams = { to: 'valid\0evil', amount: '100' };
      expect(() => router.select(params)).toThrow(/null bytes/);
    });

    it('throws for description over 1000 characters', () => {
      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        description: 'x'.repeat(1001),
      };
      expect(() => router.select(params)).toThrow(/Description too long/);
    });

    it('accepts valid dispute window', () => {
      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        disputeWindow: 3600, // 1 hour - minimum allowed
      };
      const adapter = router.select(params);
      expect(adapter).toBeDefined();
    });

    it('throws for dispute window below minimum', () => {
      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        disputeWindow: 100, // Too short
      };
      expect(() => router.select(params)).toThrow(/Invalid payment params/);
    });

    it('throws for dispute window above maximum', () => {
      const params: UnifiedPayParams = {
        to: VALID_ADDRESS,
        amount: '100',
        disputeWindow: 31 * 24 * 3600, // 31 days - over max
      };
      expect(() => router.select(params)).toThrow(/Invalid payment params/);
    });
  });

  describe('getCompatibleAdapters()', () => {
    it('returns all adapters that can handle the params', () => {
      const params: UnifiedPayParams = { to: VALID_ADDRESS, amount: '100' };
      const compatible = router.getCompatibleAdapters(params);
      expect(compatible.length).toBe(2);
      expect(compatible.map((a) => a.metadata.id)).toContain('basic');
      expect(compatible.map((a) => a.metadata.id)).toContain('standard');
    });

    it('filters out adapters that cannot handle params', () => {
      // Add adapter that can only handle HTTP
      const httpOnlyAdapter = new MockAdapter(x402Metadata, (p) =>
        p.to.startsWith('http')
      );
      registry.register(httpOnlyAdapter);

      const params: UnifiedPayParams = { to: VALID_ADDRESS, amount: '100' };
      const compatible = router.getCompatibleAdapters(params);
      expect(compatible.map((a) => a.metadata.id)).not.toContain('x402');
    });
  });

  describe('canHandle()', () => {
    it('returns true when at least one adapter can handle', () => {
      const params: UnifiedPayParams = { to: VALID_ADDRESS, amount: '100' };
      expect(router.canHandle(params)).toBe(true);
    });

    it('returns false when no adapter can handle', () => {
      // Create registry with adapter that handles nothing
      const emptyRegistry = new AdapterRegistry();
      emptyRegistry.register(new MockAdapter(basicMetadata, () => false));
      const emptyRouter = new AdapterRouter(emptyRegistry);

      const params: UnifiedPayParams = { to: VALID_ADDRESS, amount: '100' };
      expect(emptyRouter.canHandle(params)).toBe(false);
    });

    it('returns false for invalid params', () => {
      const params = { to: '', amount: '100' } as UnifiedPayParams;
      expect(router.canHandle(params)).toBe(false);
    });
  });

  describe('priority ordering', () => {
    it('higher priority adapters are tried first', () => {
      // Add low-priority adapter that always returns true
      const lowPriorityMetadata: AdapterMetadata = {
        ...basicMetadata,
        id: 'low-priority',
        priority: 10,
      };
      registry.register(new MockAdapter(lowPriorityMetadata));

      const params: UnifiedPayParams = { to: VALID_ADDRESS, amount: '100' };
      const adapter = router.select(params);
      // Standard (60) should be selected over basic (50) and low-priority (10)
      expect(adapter.metadata.id).toBe('standard');
    });
  });
});
