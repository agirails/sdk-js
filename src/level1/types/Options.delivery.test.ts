/**
 * AIP-16 Phase 2e — ServiceConfig delivery extension tests.
 *
 * Covers:
 *  - DEFAULT_DELIVERY_CONFIG shape and values.
 *  - ServiceConfig accepting undefined `delivery` (backward compatibility).
 *  - ServiceConfig accepting a full `delivery` block.
 *  - Type-narrowing on `mode` / `privacy`.
 *  - Default invariants required by the Agent.processJob hook contract.
 *
 * These tests are PURELY type/value level — they construct configs and
 * exercise the field defaults; the actual processJob hook behavior lives
 * in Agent.processJob.delivery.test.ts.
 */

import {
  DEFAULT_DELIVERY_CONFIG,
  type DeliveryServiceConfig,
} from './Options';
import type { ServiceConfig } from '../Agent';
import type {
  DeliveryMode,
  DeliveryPrivacy,
} from '../../delivery/types';

describe('AIP-16 Phase 2e — Options.ts delivery extension', () => {
  describe('DEFAULT_DELIVERY_CONFIG', () => {
    it('has mode === "channel" (backward-compatible default)', () => {
      expect(DEFAULT_DELIVERY_CONFIG.mode).toBe('channel');
    });

    it('has privacy === "public" (backward-compatible default)', () => {
      expect(DEFAULT_DELIVERY_CONFIG.privacy).toBe('public');
    });

    it('is shaped exactly as { mode, privacy } — no extra fields', () => {
      const keys = Object.keys(DEFAULT_DELIVERY_CONFIG).sort();
      expect(keys).toEqual(['mode', 'privacy']);
    });

    it('is reference-stable (object identity is preserved)', () => {
      // Importing twice should not produce different objects. We re-import
      // dynamically to defend against accidental mutation in another test.
      const reImport = jest.requireActual('./Options') as {
        DEFAULT_DELIVERY_CONFIG: DeliveryServiceConfig;
      };
      expect(reImport.DEFAULT_DELIVERY_CONFIG).toBe(DEFAULT_DELIVERY_CONFIG);
    });
  });

  describe('DeliveryServiceConfig type', () => {
    it('accepts every DeliveryMode literal', () => {
      const channel: DeliveryServiceConfig = { mode: 'channel', privacy: 'public' };
      const none: DeliveryServiceConfig = { mode: 'none', privacy: 'public' };
      expect(channel.mode).toBe('channel');
      expect(none.mode).toBe('none');
    });

    it('accepts every DeliveryPrivacy literal', () => {
      const pub: DeliveryServiceConfig = { mode: 'channel', privacy: 'public' };
      const enc: DeliveryServiceConfig = { mode: 'channel', privacy: 'encrypted' };
      expect(pub.privacy).toBe('public');
      expect(enc.privacy).toBe('encrypted');
    });

    it('narrows the DeliveryMode type when read back', () => {
      const cfg: DeliveryServiceConfig = { mode: 'channel', privacy: 'public' };
      const asMode: DeliveryMode = cfg.mode;
      expect(asMode === 'channel' || asMode === 'none').toBe(true);
    });

    it('narrows the DeliveryPrivacy type when read back', () => {
      const cfg: DeliveryServiceConfig = { mode: 'channel', privacy: 'encrypted' };
      const asPrivacy: DeliveryPrivacy = cfg.privacy;
      expect(asPrivacy === 'public' || asPrivacy === 'encrypted').toBe(true);
    });
  });

  describe('ServiceConfig backward compatibility', () => {
    it('accepts a ServiceConfig with NO delivery field (legacy shape)', () => {
      const cfg: ServiceConfig = {
        name: 'legacy-service',
      };
      expect(cfg.delivery).toBeUndefined();
    });

    it('accepts a ServiceConfig with delivery === undefined (explicit absence)', () => {
      const cfg: ServiceConfig = {
        name: 'no-delivery-service',
        delivery: undefined,
      };
      expect(cfg.delivery).toBeUndefined();
    });

    it('accepts a ServiceConfig with a full delivery block (channel + public)', () => {
      const cfg: ServiceConfig = {
        name: 'public-service',
        delivery: { mode: 'channel', privacy: 'public' },
      };
      expect(cfg.delivery).toEqual({ mode: 'channel', privacy: 'public' });
    });

    it('accepts a ServiceConfig with delivery (channel + encrypted)', () => {
      const cfg: ServiceConfig = {
        name: 'private-service',
        delivery: { mode: 'channel', privacy: 'encrypted' },
      };
      expect(cfg.delivery?.mode).toBe('channel');
      expect(cfg.delivery?.privacy).toBe('encrypted');
    });

    it('accepts a ServiceConfig with delivery.mode === "none" (sentinel/smoke)', () => {
      const cfg: ServiceConfig = {
        name: 'sentinel-service',
        delivery: { mode: 'none', privacy: 'public' },
      };
      expect(cfg.delivery?.mode).toBe('none');
    });

    it('default-substitutes DEFAULT_DELIVERY_CONFIG when delivery is omitted', () => {
      const cfg: ServiceConfig = { name: 'svc' };
      const effective = cfg.delivery ?? DEFAULT_DELIVERY_CONFIG;
      expect(effective).toBe(DEFAULT_DELIVERY_CONFIG);
      expect(effective.mode).toBe('channel');
      expect(effective.privacy).toBe('public');
    });

    it('preserves user-supplied delivery over the default', () => {
      const cfg: ServiceConfig = {
        name: 'svc',
        delivery: { mode: 'none', privacy: 'public' },
      };
      const effective = cfg.delivery ?? DEFAULT_DELIVERY_CONFIG;
      expect(effective).not.toBe(DEFAULT_DELIVERY_CONFIG);
      expect(effective.mode).toBe('none');
    });
  });

  describe('Type narrowing in branch logic', () => {
    function describeMode(mode: DeliveryMode): string {
      switch (mode) {
        case 'channel':
          return 'C';
        case 'none':
          return 'N';
        default: {
          // Exhaustive guard — should be `never` at type level.
          const _exhaustive: never = mode;
          return _exhaustive;
        }
      }
    }

    it('narrows DeliveryMode exhaustively in switch statements', () => {
      expect(describeMode('channel')).toBe('C');
      expect(describeMode('none')).toBe('N');
    });

    function describePrivacy(p: DeliveryPrivacy): string {
      if (p === 'public') return 'PUB';
      if (p === 'encrypted') return 'ENC';
      const _exhaustive: never = p;
      return _exhaustive;
    }

    it('narrows DeliveryPrivacy exhaustively in if/else chains', () => {
      expect(describePrivacy('public')).toBe('PUB');
      expect(describePrivacy('encrypted')).toBe('ENC');
    });
  });
});
