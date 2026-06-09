/**
 * AIP-16 Delivery Surface — X25519 / ECDH / HKDF unit tests.
 *
 * Covers:
 *  - generateEphemeralKeyPair: lengths, non-zero, fresh entropy on each call,
 *    publicKey ↔ publicKeyHex lock-step.
 *  - deriveSharedSecret: ECDH symmetry (alice⇄bob), length check, length-mismatch
 *    rejection, non-Uint8Array rejection.
 *  - deriveSessionKey: determinism for identical inputs, salt separation by
 *    txId, info-string separation, info-string default lock-in to
 *    `agirails-delivery-v1`, length-32 output, malformed-txId rejection.
 *  - pubkeyToHex / pubkeyFromHex roundtrip, case-insensitive hex acceptance,
 *    strict shape errors.
 *
 * Exercises real @noble/curves X25519 and node:crypto HKDF — no mocks.
 */

import {
  DELIVERY_HKDF_INFO_V1,
  DELIVERY_SESSION_KEY_LENGTH,
  DeliveryCryptoError,
  X25519_PRIVATE_KEY_LENGTH,
  X25519_PUBLIC_KEY_LENGTH,
  X25519_SHARED_SECRET_LENGTH,
  deriveSessionKey,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  pubkeyFromHex,
  pubkeyToHex,
} from './keys';

const TX_ID_A = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const TX_ID_B = ('0x' + 'bb'.repeat(32)) as `0x${string}`;

/** Assert two Uint8Arrays are byte-for-byte equal. */
function expectBytesEqual(a: Uint8Array, b: Uint8Array): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i]).toBe(b[i]);
  }
}

/** Assert two Uint8Arrays differ in at least one byte. */
function expectBytesDiffer(a: Uint8Array, b: Uint8Array): void {
  if (a.length !== b.length) {
    return; // length differs → obviously not equal
  }
  let differ = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      differ = true;
      break;
    }
  }
  expect(differ).toBe(true);
}

describe('delivery/keys — length constants', () => {
  it('exposes X25519 public-key length 32', () => {
    expect(X25519_PUBLIC_KEY_LENGTH).toBe(32);
  });

  it('exposes X25519 private-key length 32', () => {
    expect(X25519_PRIVATE_KEY_LENGTH).toBe(32);
  });

  it('exposes shared-secret length 32', () => {
    expect(X25519_SHARED_SECRET_LENGTH).toBe(32);
  });

  it('exposes session-key length 32 (AES-256-GCM)', () => {
    expect(DELIVERY_SESSION_KEY_LENGTH).toBe(32);
  });

  it('locks in the v1 HKDF info string', () => {
    expect(DELIVERY_HKDF_INFO_V1).toBe('agirails-delivery-v1');
  });
});

describe('delivery/keys — generateEphemeralKeyPair', () => {
  it('returns a 32-byte public key', () => {
    const kp = generateEphemeralKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
  });

  it('returns a 32-byte private key', () => {
    const kp = generateEphemeralKeyPair();
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.length).toBe(32);
  });

  it('public key is not all-zero', () => {
    const kp = generateEphemeralKeyPair();
    let acc = 0;
    for (const b of kp.publicKey) acc |= b;
    expect(acc).not.toBe(0);
  });

  it('private key is not all-zero', () => {
    const kp = generateEphemeralKeyPair();
    let acc = 0;
    for (const b of kp.privateKey) acc |= b;
    expect(acc).not.toBe(0);
  });

  it('publicKeyHex has the canonical "0x" + 64 lowercase chars form', () => {
    const kp = generateEphemeralKeyPair();
    expect(kp.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(kp.publicKeyHex.length).toBe(66);
  });

  it('publicKeyHex is byte-for-byte consistent with publicKey', () => {
    const kp = generateEphemeralKeyPair();
    const reconstructed = pubkeyFromHex(kp.publicKeyHex);
    expectBytesEqual(reconstructed, kp.publicKey);
  });

  it('two consecutive generations produce different public keys (entropy)', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    expectBytesDiffer(a.publicKey, b.publicKey);
  });

  it('two consecutive generations produce different private keys (entropy)', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    expectBytesDiffer(a.privateKey, b.privateKey);
  });
});

describe('delivery/keys — deriveSharedSecret (ECDH)', () => {
  it('ECDH is symmetric: f(aPriv, bPub) === f(bPriv, aPub)', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const aliceSide = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const bobSide = deriveSharedSecret(bob.privateKey, alice.publicKey);
    expectBytesEqual(aliceSide, bobSide);
  });

  it('returns a 32-byte shared secret', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const shared = deriveSharedSecret(alice.privateKey, bob.publicKey);
    expect(shared.length).toBe(32);
  });

  it('different peer keypairs produce different shared secrets', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const carol = generateEphemeralKeyPair();
    const sharedAB = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const sharedAC = deriveSharedSecret(alice.privateKey, carol.publicKey);
    expectBytesDiffer(sharedAB, sharedAC);
  });

  it('rejects a private key of wrong length with crypto_shared_secret_failed', () => {
    const peer = generateEphemeralKeyPair();
    try {
      deriveSharedSecret(new Uint8Array(31), peer.publicKey);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryCryptoError);
      expect((err as DeliveryCryptoError).code).toBe('crypto_shared_secret_failed');
    }
  });

  it('rejects a peer public key of wrong length with crypto_shared_secret_failed', () => {
    const local = generateEphemeralKeyPair();
    try {
      deriveSharedSecret(local.privateKey, new Uint8Array(33));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_shared_secret_failed');
    }
  });

  it('rejects a non-Uint8Array private key', () => {
    const peer = generateEphemeralKeyPair();
    try {
      deriveSharedSecret('not bytes' as unknown as Uint8Array, peer.publicKey);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_shared_secret_failed');
    }
  });

  it('rejects an all-zero peer public key (low-order point) with crypto_shared_secret_failed', () => {
    const local = generateEphemeralKeyPair();
    // The all-zero point is a documented low-order point on Curve25519.
    try {
      deriveSharedSecret(local.privateKey, new Uint8Array(32));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryCryptoError);
      expect((err as DeliveryCryptoError).code).toBe('crypto_shared_secret_failed');
    }
  });
});

describe('delivery/keys — deriveSessionKey (HKDF-SHA256)', () => {
  it('returns a 32-byte session key', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const shared = deriveSharedSecret(a.privateKey, b.publicKey);
    const key = deriveSessionKey(shared, TX_ID_A);
    expect(key.length).toBe(32);
  });

  it('is deterministic — same shared secret + same txId → same key', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const shared = deriveSharedSecret(a.privateKey, b.publicKey);
    const k1 = deriveSessionKey(shared, TX_ID_A);
    const k2 = deriveSessionKey(shared, TX_ID_A);
    expectBytesEqual(k1, k2);
  });

  it('different txId produces different key (salt separation)', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const shared = deriveSharedSecret(a.privateKey, b.publicKey);
    const k1 = deriveSessionKey(shared, TX_ID_A);
    const k2 = deriveSessionKey(shared, TX_ID_B);
    expectBytesDiffer(k1, k2);
  });

  it('different shared secret produces different key', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const c = generateEphemeralKeyPair();
    const sharedAB = deriveSharedSecret(a.privateKey, b.publicKey);
    const sharedAC = deriveSharedSecret(a.privateKey, c.publicKey);
    const k1 = deriveSessionKey(sharedAB, TX_ID_A);
    const k2 = deriveSessionKey(sharedAC, TX_ID_A);
    expectBytesDiffer(k1, k2);
  });

  it('different info string produces different key (context separation)', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const shared = deriveSharedSecret(a.privateKey, b.publicKey);
    const k1 = deriveSessionKey(shared, TX_ID_A); // default info
    const k2 = deriveSessionKey(shared, TX_ID_A, 'agirails-delivery-v2');
    expectBytesDiffer(k1, k2);
  });

  it('rejects malformed txId (wrong length) with crypto_hkdf_failed', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const shared = deriveSharedSecret(a.privateKey, b.publicKey);
    try {
      deriveSessionKey(shared, ('0x' + 'aa'.repeat(16)) as `0x${string}`);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryCryptoError);
      expect((err as DeliveryCryptoError).code).toBe('crypto_hkdf_failed');
    }
  });

  it('rejects malformed txId (missing 0x prefix) with crypto_hkdf_failed', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const shared = deriveSharedSecret(a.privateKey, b.publicKey);
    try {
      deriveSessionKey(shared, ('aa'.repeat(32)) as `0x${string}`);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_hkdf_failed');
    }
  });

  it('rejects malformed txId (non-hex chars) with crypto_hkdf_failed', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const shared = deriveSharedSecret(a.privateKey, b.publicKey);
    try {
      deriveSessionKey(shared, ('0x' + 'zz'.repeat(32)) as `0x${string}`);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_hkdf_failed');
    }
  });

  it('rejects shared secret of wrong length with crypto_hkdf_failed', () => {
    try {
      deriveSessionKey(new Uint8Array(31), TX_ID_A);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_hkdf_failed');
    }
  });

  it('default info string is exactly agirails-delivery-v1', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const shared = deriveSharedSecret(a.privateKey, b.publicKey);
    const kDefault = deriveSessionKey(shared, TX_ID_A);
    const kExplicit = deriveSessionKey(shared, TX_ID_A, 'agirails-delivery-v1');
    expectBytesEqual(kDefault, kExplicit);
  });
});

describe('delivery/keys — pubkeyToHex / pubkeyFromHex', () => {
  it('roundtrips a freshly generated public key', () => {
    const kp = generateEphemeralKeyPair();
    const hex = pubkeyToHex(kp.publicKey);
    const bytes = pubkeyFromHex(hex);
    expectBytesEqual(bytes, kp.publicKey);
  });

  it('pubkeyToHex output matches publicKeyHex from the keypair', () => {
    const kp = generateEphemeralKeyPair();
    expect(pubkeyToHex(kp.publicKey)).toBe(kp.publicKeyHex);
  });

  it('pubkeyToHex output is lowercase hex', () => {
    const kp = generateEphemeralKeyPair();
    const hex = pubkeyToHex(kp.publicKey);
    expect(hex).toBe(hex.toLowerCase());
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('pubkeyToHex rejects wrong-length input with crypto_keygen_failed', () => {
    try {
      pubkeyToHex(new Uint8Array(31));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_keygen_failed');
    }
  });

  it('pubkeyToHex rejects non-Uint8Array input', () => {
    try {
      pubkeyToHex('not bytes' as unknown as Uint8Array);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_keygen_failed');
    }
  });

  it('pubkeyFromHex accepts upper-case hex digits (case-insensitive input)', () => {
    const hex = '0x' + 'AB'.repeat(32);
    const bytes = pubkeyFromHex(hex);
    expect(bytes.length).toBe(32);
    expect(bytes[0]).toBe(0xab);
    expect(bytes[31]).toBe(0xab);
  });

  it('pubkeyFromHex rejects missing 0x prefix with crypto_keygen_failed', () => {
    try {
      pubkeyFromHex('ab'.repeat(32));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_keygen_failed');
    }
  });

  it('pubkeyFromHex rejects wrong-length hex with crypto_keygen_failed', () => {
    try {
      pubkeyFromHex('0x' + 'ab'.repeat(16));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_keygen_failed');
    }
  });

  it('pubkeyFromHex rejects non-hex chars after 0x with crypto_keygen_failed', () => {
    try {
      pubkeyFromHex('0x' + 'zz'.repeat(32));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_keygen_failed');
    }
  });

  it('pubkeyFromHex rejects empty input', () => {
    try {
      pubkeyFromHex('');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_keygen_failed');
    }
  });

  it('pubkeyFromHex rejects non-string input', () => {
    try {
      pubkeyFromHex(12345 as unknown as string);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_keygen_failed');
    }
  });
});

describe('delivery/keys — DeliveryCryptoError class', () => {
  it('extends Error with name DeliveryCryptoError', () => {
    const err = new DeliveryCryptoError('crypto_keygen_failed', 'msg');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DeliveryCryptoError);
    expect(err.name).toBe('DeliveryCryptoError');
  });

  it('preserves code, message, and details', () => {
    const err = new DeliveryCryptoError('crypto_hkdf_failed', 'm', { x: 1 });
    expect(err.code).toBe('crypto_hkdf_failed');
    expect(err.message).toBe('m');
    expect(err.details).toEqual({ x: 1 });
  });
});

describe('delivery/keys — end-to-end ECDH+HKDF derivation', () => {
  it('alice and bob derive the same session key via ECDH+HKDF on the same txId', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const aliceShared = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const bobShared = deriveSharedSecret(bob.privateKey, alice.publicKey);
    const aliceKey = deriveSessionKey(aliceShared, TX_ID_A);
    const bobKey = deriveSessionKey(bobShared, TX_ID_A);
    expectBytesEqual(aliceKey, bobKey);
  });

  it('alice and bob derive different session keys when txIds differ', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const aliceShared = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const bobShared = deriveSharedSecret(bob.privateKey, alice.publicKey);
    const aliceKey = deriveSessionKey(aliceShared, TX_ID_A);
    const bobKeyOtherTx = deriveSessionKey(bobShared, TX_ID_B);
    expectBytesDiffer(aliceKey, bobKeyOtherTx);
  });
});
