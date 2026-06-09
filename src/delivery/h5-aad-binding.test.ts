/**
 * AIP-16 Phase 3 H5 — AES-256-GCM AAD binding tests.
 *
 * Surface under test:
 *
 *  - `crypto.encryptBody(plaintext, sessionKey, aad?)` and
 *    `crypto.decryptBody(ciphertext, sessionKey, nonce, tag, aad?)` now
 *    accept an OPTIONAL `aad` parameter. When supplied at encrypt time,
 *    the same bytes MUST be supplied at decrypt time or the GCM tag
 *    verification fails — surfaced as `crypto_decrypt_failed`.
 *
 *  - `envelopeBuilder.buildEnvelopeAad(txId, signerAddress)` constructs
 *    the canonical 52-byte AAD `txId_bytes || signerAddress_bytes`.
 *
 *  - `DeliveryEnvelopeBuilder.buildEncrypted` always supplies AAD; the
 *    matching `decryptPayload` reconstructs it from `signed.txId` and
 *    `signed.signerAddress`.
 *
 * Threat model addressed: cross-tx envelope swap. An attacker who can
 * make a delivery channel serve an envelope built for transaction A to
 * a buyer expecting transaction B should NOT be able to open the body
 * even if the session key happens to collide (extreme defense-in-depth
 * on top of the EIP-712 signature binding over `txId`).
 *
 * All tests use real `node:crypto` AES-GCM — no mocks.
 */

import { HDNodeWallet, Wallet } from 'ethers';

import {
  AES_GCM_NONCE_LENGTH,
  AES_GCM_TAG_LENGTH,
  bytesFromHex,
  bytesToHex,
  decryptBody,
  encryptBody,
} from './crypto';
import {
  DeliveryEnvelopeBuilder,
  ENVELOPE_AAD_LENGTH,
  buildEnvelopeAad,
  type BuildEncryptedEnvelopeParams,
} from './envelopeBuilder';
import {
  deriveSessionKey,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  pubkeyFromHex,
} from './keys';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const KERNEL_A = '0x469CBADbACFFE096270594F0a31f0EEC53753411' as `0x${string}`;
const CHAIN_ID = 84532;
const BASE_NOW = 1_750_000_000;

const TX_A = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const TX_B = ('0x' + 'bb'.repeat(32)) as `0x${string}`;

/** Deterministic 32-byte AES key for primitive-level tests. */
function fixedKey(seed: number): Uint8Array {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) k[i] = (seed + i) & 0xff;
  return k;
}

/** Build a 52-byte AAD from explicit txId / signerAddress hex. */
function aadFor(txId: `0x${string}`, signer: `0x${string}`): Uint8Array {
  return buildEnvelopeAad(txId, signer);
}

function defaultEncryptedParams(
  wallet: HDNodeWallet,
  buyerPubHex: `0x${string}`,
  overrides: Partial<BuildEncryptedEnvelopeParams> = {},
): BuildEncryptedEnvelopeParams {
  return {
    txId: TX_A,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL_A,
    providerAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    payload: { secret: 'data' },
    buyerEphemeralPubkey: buyerPubHex,
    createdAt: BASE_NOW,
    ...overrides,
  };
}

// ============================================================================
// Primitive-level: encryptBody / decryptBody with AAD
// ============================================================================

describe('crypto AAD parameter — primitive-level binding', () => {
  it('encrypt+decrypt with SAME AAD succeeds and returns original plaintext', () => {
    const key = fixedKey(1);
    const aad = aadFor(TX_A, '0x' + '11'.repeat(20) as `0x${string}`);
    const plaintext = 'sealed-with-h5-aad';
    const { ciphertext, nonce, tag } = encryptBody(plaintext, key, aad);
    const recovered = decryptBody(ciphertext, key, nonce, tag, aad);
    expect(Buffer.from(recovered).toString('utf8')).toBe(plaintext);
  });

  it('encrypt with AAD_A then decrypt with AAD_B throws crypto_decrypt_failed', () => {
    const key = fixedKey(2);
    const aadA = aadFor(TX_A, '0x' + '22'.repeat(20) as `0x${string}`);
    const aadB = aadFor(TX_B, '0x' + '22'.repeat(20) as `0x${string}`);
    const { ciphertext, nonce, tag } = encryptBody('payload', key, aadA);
    expect(() => decryptBody(ciphertext, key, nonce, tag, aadB)).toThrow(
      /crypto_decrypt_failed|authentication/i,
    );
  });

  it('encrypt with AAD then decrypt with NO AAD throws crypto_decrypt_failed', () => {
    const key = fixedKey(3);
    const aad = aadFor(TX_A, '0x' + '33'.repeat(20) as `0x${string}`);
    const { ciphertext, nonce, tag } = encryptBody('payload', key, aad);
    // Omitting the AAD on the decrypt side — the GCM tag still commits
    // to the encrypt-side AAD and we should fail closed.
    expect(() => decryptBody(ciphertext, key, nonce, tag)).toThrow(
      /crypto_decrypt_failed|authentication/i,
    );
  });

  it('encrypt with NO AAD then decrypt with AAD throws crypto_decrypt_failed (symmetric)', () => {
    const key = fixedKey(4);
    const aad = aadFor(TX_A, '0x' + '44'.repeat(20) as `0x${string}`);
    const { ciphertext, nonce, tag } = encryptBody('payload', key);
    expect(() => decryptBody(ciphertext, key, nonce, tag, aad)).toThrow(
      /crypto_decrypt_failed|authentication/i,
    );
  });

  it('encrypt with empty-AAD Uint8Array succeeds when decrypted with same empty-AAD', () => {
    // Empty Uint8Array AAD is structurally distinct from `undefined` for
    // this API surface, but GCM-internally a zero-length AAD is treated
    // the same as no AAD. We assert ROUNDTRIP, not semantic equivalence
    // with `undefined`.
    const key = fixedKey(5);
    const empty = new Uint8Array(0);
    const { ciphertext, nonce, tag } = encryptBody('hi', key, empty);
    const decrypted = decryptBody(ciphertext, key, nonce, tag, empty);
    expect(Buffer.from(decrypted).toString('utf8')).toBe('hi');
  });

  it('rejects non-Uint8Array aad at encrypt with crypto_encrypt_failed', () => {
    const key = fixedKey(6);
    expect(() =>
      encryptBody('hi', key, 'not bytes' as unknown as Uint8Array),
    ).toThrow(expect.objectContaining({ code: 'crypto_encrypt_failed' }));
  });

  it('rejects non-Uint8Array aad at decrypt with crypto_decrypt_failed', () => {
    const key = fixedKey(7);
    const aad = aadFor(TX_A, '0x' + '77'.repeat(20) as `0x${string}`);
    const { ciphertext, nonce, tag } = encryptBody('hi', key, aad);
    expect(() =>
      decryptBody(
        ciphertext,
        key,
        nonce,
        tag,
        'not bytes' as unknown as Uint8Array,
      ),
    ).toThrow(expect.objectContaining({ code: 'crypto_decrypt_failed' }));
  });

  it('flipping ONE bit in the AAD at decrypt time fails the tag', () => {
    const key = fixedKey(8);
    const aad = aadFor(TX_A, '0x' + '88'.repeat(20) as `0x${string}`);
    const { ciphertext, nonce, tag } = encryptBody('hi', key, aad);
    const tampered = new Uint8Array(aad);
    tampered[0] = (tampered[0] as number) ^ 0x01;
    expect(() => decryptBody(ciphertext, key, nonce, tag, tampered)).toThrow(
      /crypto_decrypt_failed|authentication/i,
    );
  });
});

// ============================================================================
// buildEnvelopeAad — structural correctness
// ============================================================================

describe('buildEnvelopeAad — construction', () => {
  it('produces a 52-byte buffer (32 + 20)', () => {
    const aad = buildEnvelopeAad(
      TX_A,
      '0x' + '99'.repeat(20) as `0x${string}`,
    );
    expect(aad.length).toBe(ENVELOPE_AAD_LENGTH);
    expect(aad.length).toBe(52);
  });

  it('layout: aad[0..32) = txId bytes, aad[32..52) = signer bytes', () => {
    const signer = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`;
    const aad = buildEnvelopeAad(TX_A, signer);
    const txIdBytes = bytesFromHex(TX_A);
    const signerBytes = bytesFromHex(signer);
    for (let i = 0; i < 32; i++) {
      expect(aad[i]).toBe(txIdBytes[i]);
    }
    for (let i = 0; i < 20; i++) {
      expect(aad[32 + i]).toBe(signerBytes[i]);
    }
  });

  it('is case-insensitive on signer hex (checksum vs lowercase round-trip)', () => {
    const lower = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`;
    const upper = '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD' as `0x${string}`;
    const a = buildEnvelopeAad(TX_A, lower);
    const b = buildEnvelopeAad(TX_A, upper);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('different txIds produce different AAD even for same signer', () => {
    const signer = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`;
    const a = buildEnvelopeAad(TX_A, signer);
    const b = buildEnvelopeAad(TX_B, signer);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('different signers produce different AAD even for same txId', () => {
    const s1 = '0x1111111111111111111111111111111111111111' as `0x${string}`;
    const s2 = '0x2222222222222222222222222222222222222222' as `0x${string}`;
    const a = buildEnvelopeAad(TX_A, s1);
    const b = buildEnvelopeAad(TX_A, s2);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});

// ============================================================================
// Envelope-level: buildEncrypted always binds AAD; decryptPayload too
// ============================================================================

describe('DeliveryEnvelopeBuilder.buildEncrypted — H5 AAD binding', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  it('envelope round-trip succeeds via verifyAndDecrypt (AAD reconstruction matches)', async () => {
    const buyerKp = generateEphemeralKeyPair();
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const payload = { greeting: 'hello-h5', items: [1, 2, 3] };
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex, { payload }),
    );

    const result = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
      wire,
      buyerKp.privateKey,
      {
        expectedKernelAddress: KERNEL_A,
        expectedChainId: CHAIN_ID,
        now: BASE_NOW,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(payload);
    }
  });

  it('same payload + same buyer pubkey but different txId yields different ciphertext (nonce + AAD both differ)', async () => {
    const buyerKp = generateEphemeralKeyPair();
    const providerKp = generateEphemeralKeyPair();
    const builder = new DeliveryEnvelopeBuilder(wallet);

    const buildOne = async (txId: `0x${string}`) =>
      builder.buildEncrypted(
        defaultEncryptedParams(wallet, buyerKp.publicKeyHex, {
          txId,
          // Pin the provider keypair so the session keys also differ
          // ONLY because of the HKDF-salt txId — keeping the test
          // honest. The AAD is independently different too.
          providerEphemeralKeyPair: providerKp,
        }),
      );

    const a = await buildOne(TX_A);
    const b = await buildOne(TX_B);

    expect(a.wire.body).not.toBe(b.wire.body);
    expect(a.wire.signed.payloadHash).not.toBe(b.wire.signed.payloadHash);
  });

  it('cross-tx swap attack: envelope built for TX_A cannot be opened by mutating signed.txId to TX_B', async () => {
    const buyerKp = generateEphemeralKeyPair();
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const payload = { secret: 'cross-tx-target' };

    // Provider builds envelope for TX_A.
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex, {
        txId: TX_A,
        payload,
      }),
    );

    // Attacker tries to deliver the envelope to a buyer expecting TX_B.
    // To bypass the EIP-712 layer in this isolated test, we go straight
    // to `decryptPayload` (the primitive that does NOT enforce the
    // signature — `verify` would catch this far earlier in real use).
    // Mutate the signed-side txId so AAD reconstruction targets TX_B.
    const swapped = {
      ...wire,
      signed: { ...wire.signed, txId: TX_B },
    };

    // Decryption MUST fail closed even though the buyer's private key
    // would normally derive a valid session key — because the AAD now
    // commits to TX_B but the ciphertext was sealed under TX_A's AAD,
    // GCM tag verification fails.
    await expect(
      DeliveryEnvelopeBuilder.decryptPayload(swapped, buyerKp.privateKey),
    ).rejects.toThrow(/crypto_decrypt_failed|authentication/i);
  });

  it('cross-signer swap attack: mutating signed.signerAddress prevents decrypt', async () => {
    const buyerKp = generateEphemeralKeyPair();
    const builder = new DeliveryEnvelopeBuilder(wallet);

    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );

    const otherSigner =
      '0xdEAD000000000000000000000000000000000000' as `0x${string}`;
    const swapped = {
      ...wire,
      signed: { ...wire.signed, signerAddress: otherSigner },
    };

    await expect(
      DeliveryEnvelopeBuilder.decryptPayload(swapped, buyerKp.privateKey),
    ).rejects.toThrow(/crypto_decrypt_failed|authentication/i);
  });

  it('manual ECDH+HKDF decrypt: must supply matching AAD to recover plaintext', async () => {
    // This test asserts the build-side AAD is exactly what
    // `buildEnvelopeAad(signed.txId, signed.signerAddress)` returns —
    // i.e. the documented format. Any silent drift in the AAD format
    // would surface here.
    const buyerKp = generateEphemeralKeyPair();
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const payload = { result: 'ok-manual' };
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex, { payload }),
    );

    const providerPub = pubkeyFromHex(wire.signed.providerEphemeralPubkey);
    const shared = deriveSharedSecret(buyerKp.privateKey, providerPub);
    const sessionKey = deriveSessionKey(shared, wire.signed.txId);

    const ciphertext = bytesFromHex(wire.body);
    const nonce = bytesFromHex(wire.signed.nonce);
    const tag = bytesFromHex(wire.signed.tag);

    // (a) Without AAD: MUST fail.
    expect(() => decryptBody(ciphertext, sessionKey, nonce, tag)).toThrow(
      /crypto_decrypt_failed|authentication/i,
    );

    // (b) With AAD = builder canonical format: MUST succeed.
    const aad = buildEnvelopeAad(wire.signed.txId, wire.signed.signerAddress);
    const recovered = decryptBody(ciphertext, sessionKey, nonce, tag, aad);
    const json = Buffer.from(recovered).toString('utf8');
    expect(JSON.parse(json)).toEqual(payload);
  });

  it('nonce remains 12 bytes and tag remains 16 bytes when AAD is supplied (wire shape unchanged)', async () => {
    const buyerKp = generateEphemeralKeyPair();
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );

    expect(bytesFromHex(wire.signed.nonce).length).toBe(AES_GCM_NONCE_LENGTH);
    expect(bytesFromHex(wire.signed.tag).length).toBe(AES_GCM_TAG_LENGTH);
  });
});
