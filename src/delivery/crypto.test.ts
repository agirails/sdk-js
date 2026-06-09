/**
 * AIP-16 Delivery Surface — AES-256-GCM + body hashing unit tests.
 *
 * Covers:
 *  - encryptBody: nonce is exactly 12 bytes, tag is exactly 16 bytes,
 *    ciphertext length equals plaintext length (GCM is a stream cipher).
 *  - Roundtrip: decryptBody(encrypt(p, k), k, nonce, tag) === p, for both
 *    string and Uint8Array plaintext.
 *  - Authentication failures: wrong key, tampered ciphertext (single-bit
 *    flip), tampered tag (single-bit flip), wrong nonce, swapped nonce/tag
 *    lengths — all must throw `crypto_decrypt_failed`.
 *  - bodyHash: deterministic, lowercase `0x` + 64 hex chars, distinct
 *    inputs → distinct outputs, accepts both string and bytes, and
 *    matches `ethers.keccak256(toUtf8Bytes(body))` (interop with the
 *    on-chain payloadHash).
 *  - bytesToHex / bytesFromHex: roundtrip including empty array, case-
 *    insensitive input, strict errors on malformed input.
 *
 * Exercises real node:crypto AES-GCM and ethers keccak256 — no mocks.
 */

import { ethers } from 'ethers';

import {
  AES_GCM_NONCE_LENGTH,
  AES_GCM_TAG_LENGTH,
  AES_KEY_LENGTH,
  bodyHash,
  bytesFromHex,
  bytesToHex,
  decryptBody,
  encryptBody,
} from './crypto';
import { DeliveryCryptoError, generateEphemeralKeyPair, deriveSharedSecret, deriveSessionKey } from './keys';

const TX_ID = ('0x' + 'aa'.repeat(32)) as `0x${string}`;

/** Build a deterministic 32-byte AES key for tests that don't need ECDH. */
function fixedKey(seed: number): Uint8Array {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) k[i] = (seed + i) & 0xff;
  return k;
}

function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

function expectBytesEqual(a: Uint8Array, b: Uint8Array): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
}

describe('delivery/crypto — length constants', () => {
  it('AES_GCM_NONCE_LENGTH is 12 (NIST SP 800-38D §5.2.1.1)', () => {
    expect(AES_GCM_NONCE_LENGTH).toBe(12);
  });

  it('AES_GCM_TAG_LENGTH is 16 (full GCM tag length)', () => {
    expect(AES_GCM_TAG_LENGTH).toBe(16);
  });

  it('AES_KEY_LENGTH is 32 (AES-256)', () => {
    expect(AES_KEY_LENGTH).toBe(32);
  });
});

describe('delivery/crypto — encryptBody', () => {
  it('returns a 12-byte nonce', () => {
    const key = fixedKey(1);
    const result = encryptBody('hello', key);
    expect(result.nonce).toBeInstanceOf(Uint8Array);
    expect(result.nonce.length).toBe(12);
  });

  it('returns a 16-byte tag', () => {
    const key = fixedKey(2);
    const result = encryptBody('hello', key);
    expect(result.tag).toBeInstanceOf(Uint8Array);
    expect(result.tag.length).toBe(16);
  });

  it('ciphertext length equals plaintext byte length (GCM is a stream mode)', () => {
    const key = fixedKey(3);
    const plaintext = 'the quick brown fox jumps over the lazy dog';
    const ptBytes = utf8(plaintext);
    const result = encryptBody(plaintext, key);
    expect(result.ciphertext.length).toBe(ptBytes.length);
  });

  it('produces different nonces for two consecutive encryptions', () => {
    const key = fixedKey(4);
    const a = encryptBody('hello', key);
    const b = encryptBody('hello', key);
    let differ = false;
    for (let i = 0; i < 12; i++) {
      if (a.nonce[i] !== b.nonce[i]) {
        differ = true;
        break;
      }
    }
    expect(differ).toBe(true);
  });

  it('rejects a session key of wrong length with crypto_encrypt_failed', () => {
    try {
      encryptBody('hello', new Uint8Array(16));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryCryptoError);
      expect((err as DeliveryCryptoError).code).toBe('crypto_encrypt_failed');
    }
  });

  it('rejects a non-Uint8Array session key', () => {
    try {
      encryptBody('hello', 'not bytes' as unknown as Uint8Array);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_encrypt_failed');
    }
  });

  it('accepts Uint8Array plaintext', () => {
    const key = fixedKey(5);
    const pt = utf8('byte input');
    const result = encryptBody(pt, key);
    expect(result.ciphertext.length).toBe(pt.length);
  });
});

describe('delivery/crypto — encrypt → decrypt roundtrip', () => {
  it('decrypts back to the exact UTF-8 plaintext', () => {
    const key = fixedKey(6);
    const plaintext = '{"result":"ok","x":42}';
    const { ciphertext, nonce, tag } = encryptBody(plaintext, key);
    const decrypted = decryptBody(ciphertext, key, nonce, tag);
    expect(Buffer.from(decrypted).toString('utf8')).toBe(plaintext);
  });

  it('roundtrips an empty plaintext string', () => {
    const key = fixedKey(7);
    const { ciphertext, nonce, tag } = encryptBody('', key);
    expect(ciphertext.length).toBe(0);
    const decrypted = decryptBody(ciphertext, key, nonce, tag);
    expect(decrypted.length).toBe(0);
  });

  it('roundtrips raw Uint8Array plaintext byte-for-byte', () => {
    const key = fixedKey(8);
    const pt = new Uint8Array(256);
    for (let i = 0; i < 256; i++) pt[i] = i;
    const { ciphertext, nonce, tag } = encryptBody(pt, key);
    const decrypted = decryptBody(ciphertext, key, nonce, tag);
    expectBytesEqual(decrypted, pt);
  });

  it('roundtrips with an ECDH-derived session key', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const shared = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const key = deriveSessionKey(shared, TX_ID);
    const plaintext = 'cross-party message';
    const { ciphertext, nonce, tag } = encryptBody(plaintext, key);
    const decrypted = decryptBody(ciphertext, key, nonce, tag);
    expect(Buffer.from(decrypted).toString('utf8')).toBe(plaintext);
  });
});

describe('delivery/crypto — decryptBody authentication failures', () => {
  it('throws crypto_decrypt_failed with wrong key', () => {
    const key = fixedKey(9);
    const wrongKey = fixedKey(99);
    const { ciphertext, nonce, tag } = encryptBody('hello', key);
    try {
      decryptBody(ciphertext, wrongKey, nonce, tag);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryCryptoError);
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });

  it('throws crypto_decrypt_failed when ciphertext is tampered (single-bit flip)', () => {
    const key = fixedKey(10);
    const { ciphertext, nonce, tag } = encryptBody('hello world', key);
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0x01;
    try {
      decryptBody(tampered, key, nonce, tag);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });

  it('throws crypto_decrypt_failed when tag is tampered (single-bit flip)', () => {
    const key = fixedKey(11);
    const { ciphertext, nonce, tag } = encryptBody('hello world', key);
    const tamperedTag = new Uint8Array(tag);
    tamperedTag[0] ^= 0x01;
    try {
      decryptBody(ciphertext, key, nonce, tamperedTag);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });

  it('throws crypto_decrypt_failed with a wrong nonce', () => {
    const key = fixedKey(12);
    const { ciphertext, tag } = encryptBody('hello world', key);
    const wrongNonce = new Uint8Array(12); // all zeros — overwhelmingly never equal to a random nonce
    try {
      decryptBody(ciphertext, key, wrongNonce, tag);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });

  it('throws crypto_decrypt_failed when nonce length is wrong', () => {
    const key = fixedKey(13);
    const { ciphertext, tag } = encryptBody('hello world', key);
    try {
      decryptBody(ciphertext, key, new Uint8Array(11), tag);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });

  it('throws crypto_decrypt_failed when tag length is wrong', () => {
    const key = fixedKey(14);
    const { ciphertext, nonce } = encryptBody('hello world', key);
    try {
      decryptBody(ciphertext, key, nonce, new Uint8Array(15));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });

  it('throws crypto_decrypt_failed when session key length is wrong', () => {
    const key = fixedKey(15);
    const { ciphertext, nonce, tag } = encryptBody('hello', key);
    try {
      decryptBody(ciphertext, new Uint8Array(16), nonce, tag);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });

  it('throws crypto_decrypt_failed for non-Uint8Array ciphertext', () => {
    const key = fixedKey(16);
    const { nonce, tag } = encryptBody('hello', key);
    try {
      decryptBody('not bytes' as unknown as Uint8Array, key, nonce, tag);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });
});

describe('delivery/crypto — bodyHash', () => {
  it('returns 0x + 64 lowercase hex chars', () => {
    const h = bodyHash('hello');
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.length).toBe(66);
  });

  it('is deterministic — same input → same output', () => {
    const h1 = bodyHash('the quick brown fox');
    const h2 = bodyHash('the quick brown fox');
    expect(h1).toBe(h2);
  });

  it('different inputs produce different hashes', () => {
    expect(bodyHash('a')).not.toBe(bodyHash('b'));
  });

  it('matches ethers.keccak256(toUtf8Bytes(body)) — interop with on-chain payloadHash', () => {
    const body = '{"result":"ok"}';
    const ours = bodyHash(body);
    const theirs = ethers.keccak256(ethers.toUtf8Bytes(body));
    expect(ours).toBe(theirs);
  });

  it('treats string and Uint8Array (UTF-8) input identically for ASCII', () => {
    const ascii = 'hello world';
    const hStr = bodyHash(ascii);
    const hBytes = bodyHash(utf8(ascii));
    expect(hStr).toBe(hBytes);
  });

  it('hashes empty body to the keccak256 of the empty bytestring', () => {
    expect(bodyHash('')).toBe(ethers.keccak256(new Uint8Array(0)));
  });

  it('hash output is byte-identical for equal Uint8Arrays', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(bodyHash(a)).toBe(bodyHash(b));
  });

  it('produces different hashes for ciphertext vs plaintext (encrypted-scheme binding)', () => {
    const key = fixedKey(17);
    const plaintext = '{"data":"secret"}';
    const { ciphertext } = encryptBody(plaintext, key);
    expect(bodyHash(ciphertext)).not.toBe(bodyHash(plaintext));
  });
});

describe('delivery/crypto — bytesToHex / bytesFromHex', () => {
  it('roundtrips an arbitrary byte array', () => {
    const b = new Uint8Array(64);
    for (let i = 0; i < 64; i++) b[i] = (i * 7 + 13) & 0xff;
    const hex = bytesToHex(b);
    const back = bytesFromHex(hex);
    expectBytesEqual(back, b);
  });

  it('roundtrips an empty byte array', () => {
    const hex = bytesToHex(new Uint8Array(0));
    expect(hex).toBe('0x');
    const back = bytesFromHex('0x');
    expect(back.length).toBe(0);
  });

  it('bytesToHex output is 0x-prefixed lowercase hex', () => {
    const hex = bytesToHex(new Uint8Array([0xab, 0xcd, 0xef]));
    expect(hex).toBe('0xabcdef');
  });

  it('bytesFromHex accepts upper-case hex digits', () => {
    const bytes = bytesFromHex('0xABCDEF');
    expect(bytes.length).toBe(3);
    expect(bytes[0]).toBe(0xab);
    expect(bytes[1]).toBe(0xcd);
    expect(bytes[2]).toBe(0xef);
  });

  it('bytesToHex rejects non-Uint8Array input with crypto_encrypt_failed', () => {
    try {
      bytesToHex('not bytes' as unknown as Uint8Array);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_encrypt_failed');
    }
  });

  it('bytesFromHex rejects missing 0x prefix with crypto_decrypt_failed', () => {
    try {
      bytesFromHex('abcd');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });

  it('bytesFromHex rejects odd-length hex with crypto_decrypt_failed', () => {
    try {
      bytesFromHex('0xabc');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });

  it('bytesFromHex rejects non-hex chars with crypto_decrypt_failed', () => {
    try {
      bytesFromHex('0xzzzz');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });

  it('bytesFromHex rejects non-string input', () => {
    try {
      bytesFromHex(1234 as unknown as string);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryCryptoError).code).toBe('crypto_decrypt_failed');
    }
  });
});
