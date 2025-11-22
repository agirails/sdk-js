/**
 * Tests for Nonce Manager
 */

import {
  InMemoryNonceManager,
  DIDScopedNonceManager,
  createNonceManager
} from '../../utils/NonceManager';

describe('InMemoryNonceManager', () => {
  let manager: InMemoryNonceManager;

  beforeEach(() => {
    manager = new InMemoryNonceManager();
  });

  describe('getNextNonce', () => {
    it('should return 1 for first nonce', () => {
      expect(manager.getNextNonce('agirails.delivery.v1')).toBe(1);
    });

    it('should increment for multiple calls', () => {
      expect(manager.getNextNonce('agirails.delivery.v1')).toBe(1);
      manager.recordNonce('agirails.delivery.v1', 1);
      expect(manager.getNextNonce('agirails.delivery.v1')).toBe(2);
      manager.recordNonce('agirails.delivery.v1', 2);
      expect(manager.getNextNonce('agirails.delivery.v1')).toBe(3);
    });

    it('should track nonces separately per message type', () => {
      manager.recordNonce('agirails.delivery.v1', 5);
      manager.recordNonce('agirails.quote.v1', 10);

      expect(manager.getNextNonce('agirails.delivery.v1')).toBe(6);
      expect(manager.getNextNonce('agirails.quote.v1')).toBe(11);
    });
  });

  describe('recordNonce', () => {
    it('should update current nonce', () => {
      manager.recordNonce('agirails.delivery.v1', 5);
      expect(manager.getCurrentNonce('agirails.delivery.v1')).toBe(5);
    });

    it('should throw if nonce is not strictly increasing', () => {
      manager.recordNonce('agirails.delivery.v1', 5);

      expect(() => manager.recordNonce('agirails.delivery.v1', 5))
        .toThrow('Nonce must be strictly increasing');

      expect(() => manager.recordNonce('agirails.delivery.v1', 3))
        .toThrow('Nonce must be strictly increasing');
    });

    it('should allow gaps in nonces', () => {
      manager.recordNonce('agirails.delivery.v1', 1);
      manager.recordNonce('agirails.delivery.v1', 10);

      expect(manager.getCurrentNonce('agirails.delivery.v1')).toBe(10);
    });
  });

  describe('getCurrentNonce', () => {
    it('should return 0 for unused message type', () => {
      expect(manager.getCurrentNonce('agirails.unknown.v1')).toBe(0);
    });

    it('should return last recorded nonce', () => {
      manager.recordNonce('agirails.delivery.v1', 42);
      expect(manager.getCurrentNonce('agirails.delivery.v1')).toBe(42);
    });
  });

  describe('resetNonce', () => {
    it('should reset nonce to 0', () => {
      manager.recordNonce('agirails.delivery.v1', 10);
      manager.resetNonce('agirails.delivery.v1');

      expect(manager.getCurrentNonce('agirails.delivery.v1')).toBe(0);
      expect(manager.getNextNonce('agirails.delivery.v1')).toBe(1);
    });
  });

  describe('getAllNonces', () => {
    it('should return all nonces as object', () => {
      manager.recordNonce('agirails.delivery.v1', 5);
      manager.recordNonce('agirails.quote.v1', 10);

      const nonces = manager.getAllNonces();

      expect(nonces).toEqual({
        'agirails.delivery.v1': 5,
        'agirails.quote.v1': 10
      });
    });

    it('should be empty for new manager', () => {
      expect(manager.getAllNonces()).toEqual({});
    });
  });

  describe('constructor with initialNonces', () => {
    it('should initialize with provided nonces', () => {
      const manager = new InMemoryNonceManager({
        'agirails.delivery.v1': 100,
        'agirails.quote.v1': 200
      });

      expect(manager.getCurrentNonce('agirails.delivery.v1')).toBe(100);
      expect(manager.getCurrentNonce('agirails.quote.v1')).toBe(200);
    });
  });
});

describe('DIDScopedNonceManager', () => {
  const did1 = 'did:ethr:84532:0x1111111111111111111111111111111111111111';
  const did2 = 'did:ethr:84532:0x2222222222222222222222222222222222222222';

  let manager: DIDScopedNonceManager;

  beforeEach(() => {
    manager = new DIDScopedNonceManager(did1);
  });

  describe('DID scoping', () => {
    it('should track nonces per DID', () => {
      manager.recordNonceForDID(did1, 'agirails.delivery.v1', 5);
      manager.recordNonceForDID(did2, 'agirails.delivery.v1', 10);

      expect(manager.getNextNonceForDID(did1, 'agirails.delivery.v1')).toBe(6);
      expect(manager.getNextNonceForDID(did2, 'agirails.delivery.v1')).toBe(11);
    });

    it('should use current DID for simple methods', () => {
      manager.recordNonce('agirails.delivery.v1', 5);

      expect(manager.getCurrentNonce('agirails.delivery.v1')).toBe(5);
      expect(manager.getNextNonce('agirails.delivery.v1')).toBe(6);
    });

    it('should allow switching DID context', () => {
      manager.recordNonce('agirails.delivery.v1', 5);

      manager.switchDID(did2);
      expect(manager.getCurrentNonce('agirails.delivery.v1')).toBe(0);

      manager.recordNonce('agirails.delivery.v1', 10);

      manager.switchDID(did1);
      expect(manager.getCurrentNonce('agirails.delivery.v1')).toBe(5);
    });
  });

  describe('getAllNonces', () => {
    it('should return nested structure', () => {
      manager.recordNonceForDID(did1, 'agirails.delivery.v1', 5);
      manager.recordNonceForDID(did1, 'agirails.quote.v1', 3);
      manager.recordNonceForDID(did2, 'agirails.delivery.v1', 10);

      const nonces = manager.getAllNonces();

      expect(nonces).toEqual({
        [did1]: {
          'agirails.delivery.v1': 5,
          'agirails.quote.v1': 3
        },
        [did2]: {
          'agirails.delivery.v1': 10
        }
      });
    });
  });

  describe('constructor with initialNonces', () => {
    it('should initialize DID with provided nonces', () => {
      const manager = new DIDScopedNonceManager(did1, {
        'agirails.delivery.v1': 100
      });

      expect(manager.getCurrentNonce('agirails.delivery.v1')).toBe(100);
      expect(manager.getNextNonce('agirails.delivery.v1')).toBe(101);
    });
  });
});

describe('createNonceManager factory', () => {
  it('should create InMemoryNonceManager when no DID provided', () => {
    const manager = createNonceManager();
    expect(manager).toBeInstanceOf(InMemoryNonceManager);
  });

  it('should create DIDScopedNonceManager when DID provided', () => {
    const manager = createNonceManager('did:ethr:84532:0x...');
    expect(manager).toBeInstanceOf(DIDScopedNonceManager);
  });

  it('should pass initialNonces to manager', () => {
    const manager = createNonceManager(undefined, {
      'agirails.delivery.v1': 50
    });

    expect(manager.getCurrentNonce('agirails.delivery.v1')).toBe(50);
  });
});
