/**
 * serviceNameForHash tests (PRD §5.8).
 *
 * Covers the reverse-lookup contract `actp agent` relies on to map
 * `tx.serviceHash` back to a policy service name. The hash must be
 * computed via the same formula `Agent.provide(name)` uses
 * (`keccak256(toUtf8Bytes(name))`) — divergence here would silently
 * route every TX to the wrong service or skip everything.
 */

import { keccak256, toUtf8Bytes, ZeroHash } from 'ethers';
import { serviceNameForHash } from './serviceNameForHash';

describe('serviceNameForHash (PRD §5.8)', () => {
  const ONBOARDING = keccak256(toUtf8Bytes('onboarding'));
  const TRANSLATE = keccak256(toUtf8Bytes('translate'));
  const TRANSCRIBE = keccak256(toUtf8Bytes('transcribe'));

  it('returns the matching service name for a known hash', () => {
    expect(serviceNameForHash(ONBOARDING, ['onboarding', 'translate'])).toBe('onboarding');
    expect(serviceNameForHash(TRANSLATE, ['onboarding', 'translate'])).toBe('translate');
  });

  it('returns undefined when the hash matches no configured service', () => {
    expect(serviceNameForHash(TRANSCRIBE, ['onboarding', 'translate'])).toBeUndefined();
  });

  it('returns undefined when the configured-services list is empty', () => {
    expect(serviceNameForHash(ONBOARDING, [])).toBeUndefined();
  });

  it('returns undefined when the hash is missing', () => {
    expect(serviceNameForHash(undefined, ['onboarding'])).toBeUndefined();
    expect(serviceNameForHash('', ['onboarding'])).toBeUndefined();
  });

  it('returns undefined for ZeroHash (Level 0 pay semantics — no handler routing)', () => {
    expect(serviceNameForHash(ZeroHash, ['onboarding', 'translate'])).toBeUndefined();
  });

  it('matches case-insensitively on the hex hash', () => {
    // Upper-cased hash string still hits the lookup. `Agent.provide` and
    // BlockchainRuntime emit lowercase, but defensive normalization
    // protects against any future caller that uppercases the hex.
    const upperHash = ONBOARDING.toUpperCase().replace('0X', '0x');
    expect(serviceNameForHash(upperHash, ['onboarding'])).toBe('onboarding');
  });

  it('does not match a case-different service name (Agent.provide hashes as-is)', () => {
    // 'Onboarding' (capital O) hashes differently from 'onboarding'.
    // Provider registered 'onboarding'; on-chain tx for 'Onboarding'
    // produces a different bytes32 and must miss.
    const upperName = keccak256(toUtf8Bytes('Onboarding'));
    expect(serviceNameForHash(upperName, ['onboarding'])).toBeUndefined();
  });

  it('returns the first match when two configured names collide (defensive)', () => {
    // keccak256 collisions are astronomically unlikely in practice, but
    // duplicate-name registration is impossible per Agent.provide, and
    // duplicates in `policy.services` would be a config bug. The
    // helper returns the first match — this is documented behavior, not
    // a contract guarantee, but stability matters for the test.
    expect(serviceNameForHash(ONBOARDING, ['onboarding', 'onboarding'])).toBe('onboarding');
  });
});
