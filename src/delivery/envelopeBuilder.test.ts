/**
 * Unit tests for DeliveryEnvelopeBuilder (AIP-16 Phase 2b).
 *
 * Covers:
 *  - buildPublic() happy path + canonical-empty enforcement.
 *  - buildEncrypted() happy path + AES-GCM roundtrip with X25519 ECDH.
 *  - verify() positive + all adversarial paths (signature, payloadHash,
 *    scheme/canonical-empty rule, kernel, chainId, timestamp skew).
 *  - decryptPayload() error paths (wrong key, tampered body, public scheme).
 *  - verifyAndDecrypt() composition.
 *  - Deterministic encrypted fixtures via injected provider keypair.
 */

import { HDNodeWallet, Wallet } from 'ethers';

import {
  bodyHash,
  bytesFromHex,
  bytesToHex,
} from './crypto';
import {
  DeliveryEip712Error,
  recoverEnvelopeSigner,
} from './eip712';
import {
  DeliveryEnvelopeBuilder,
  ENVELOPE_TIMESTAMP_SKEW_SEC,
  resetSecondsNowForTests,
  setSecondsNowForTests,
  type BuildEncryptedEnvelopeParams,
  type BuildPublicEnvelopeParams,
} from './envelopeBuilder';
import {
  deriveSessionKey,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  pubkeyFromHex,
  pubkeyToHex,
} from './keys';
import {
  CANONICAL_EMPTY_BYTES12,
  CANONICAL_EMPTY_BYTES16,
  CANONICAL_EMPTY_BYTES32,
  type DeliveryEnvelopeWireV1,
} from './types';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const KERNEL_A = '0x469CBADbACFFE096270594F0a31f0EEC53753411';
const KERNEL_B = '0x132B9eB321dBB57c828B083844287171BDC92d29';
const CHAIN_ID = 84532;
const BASE_NOW = 1_750_000_000;
const TX_ID = ('0x' + '11'.repeat(32)) as `0x${string}`;

function defaultPublicParams(
  wallet: HDNodeWallet,
  overrides: Partial<BuildPublicEnvelopeParams> = {},
): BuildPublicEnvelopeParams {
  return {
    txId: TX_ID,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL_A as `0x${string}`,
    providerAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    payload: { result: 'ok' },
    createdAt: BASE_NOW,
    ...overrides,
  };
}

function defaultEncryptedParams(
  wallet: HDNodeWallet,
  buyerPubHex: `0x${string}`,
  overrides: Partial<BuildEncryptedEnvelopeParams> = {},
): BuildEncryptedEnvelopeParams {
  return {
    txId: TX_ID,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL_A as `0x${string}`,
    providerAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    payload: { secret: 'data' },
    buyerEphemeralPubkey: buyerPubHex,
    createdAt: BASE_NOW,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// buildPublic
// ----------------------------------------------------------------------------

describe('DeliveryEnvelopeBuilder.buildPublic()', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  afterEach(() => {
    resetSecondsNowForTests();
  });

  test('produces wire with scheme=public-v1 + canonical-empty crypto fields', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(defaultPublicParams(wallet));
    expect(wire.signed.scheme).toBe('public-v1');
    expect(wire.signed.providerEphemeralPubkey).toBe(CANONICAL_EMPTY_BYTES32);
    expect(wire.signed.nonce).toBe(CANONICAL_EMPTY_BYTES12);
    expect(wire.signed.tag).toBe(CANONICAL_EMPTY_BYTES16);
  });

  test('payloadHash equals bodyHash(utf8(JSON.stringify(payload)))', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const payload = { result: 'ok', n: 42 };
    const { wire, bodyBytes } = await builder.buildPublic(
      defaultPublicParams(wallet, { payload }),
    );
    expect(wire.signed.payloadHash).toBe(bodyHash(bodyBytes));
    expect(wire.signed.payloadHash).toBe(bodyHash(JSON.stringify(payload)));
  });

  test('wire.body is plaintext UTF-8 JSON (FIX-1: not hex)', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const payload = { hello: 'world' };
    const { wire } = await builder.buildPublic(defaultPublicParams(wallet, { payload }));
    // FIX-1: wire.body is the JSON.stringify(payload) STRING verbatim.
    // It MUST NOT start with "0x" (which would be a hex wrapper).
    expect(wire.body).toBe(JSON.stringify(payload));
    expect(JSON.parse(wire.body)).toEqual(payload);
    expect(wire.body.startsWith('0x')).toBe(false);
  });

  test('throws BUILDER_NO_SIGNER when no signer', async () => {
    const builder = new DeliveryEnvelopeBuilder();
    await expect(builder.buildPublic(defaultPublicParams(wallet))).rejects.toMatchObject({
      code: 'BUILDER_NO_SIGNER',
    });
  });

  test('throws BUILDER_SIGNER_ADDRESS_MISMATCH when params.signerAddress != EOA', async () => {
    const other = Wallet.createRandom();
    const builder = new DeliveryEnvelopeBuilder(wallet);
    await expect(
      builder.buildPublic(defaultPublicParams(wallet, { signerAddress: other.address as `0x${string}` })),
    ).rejects.toMatchObject({ code: 'BUILDER_SIGNER_ADDRESS_MISMATCH' });
  });

  test('signerAddress comparison case-insensitive', async () => {
    // Preserve `0x` prefix; only flip hex body. `0X…` is ENS-like to ethers.
    const upper = ('0x' + wallet.address.slice(2).toUpperCase()) as `0x${string}`;
    const builder = new DeliveryEnvelopeBuilder(wallet);
    await expect(
      builder.buildPublic(defaultPublicParams(wallet, { signerAddress: upper })),
    ).resolves.toBeDefined();
  });

  test('createdAt default flows through secondsNow seam', async () => {
    setSecondsNowForTests(() => 1_800_000_000);
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic({
      ...defaultPublicParams(wallet),
      createdAt: undefined,
    });
    expect(wire.signed.createdAt).toBe(1_800_000_000);
  });

  test('throws BUILDER_INVALID_CREATED_AT for non-positive createdAt', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    await expect(
      builder.buildPublic(defaultPublicParams(wallet, { createdAt: 0 })),
    ).rejects.toMatchObject({ code: 'BUILDER_INVALID_CREATED_AT' });
    await expect(
      builder.buildPublic(defaultPublicParams(wallet, { createdAt: -1 })),
    ).rejects.toMatchObject({ code: 'BUILDER_INVALID_CREATED_AT' });
  });

  test('blobKey is undefined for public scheme', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const result = await builder.buildPublic(defaultPublicParams(wallet));
    expect(result.blobKey).toBeUndefined();
  });

  test('bodyBytes equals utf8 bytes of JSON.stringify(payload)', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const payload = { a: [1, 2, 3] };
    const { bodyBytes } = await builder.buildPublic(defaultPublicParams(wallet, { payload }));
    expect(Buffer.from(bodyBytes).toString('utf8')).toBe(JSON.stringify(payload));
  });

  test('signature recovers to provider EOA', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(defaultPublicParams(wallet));
    const recovered = recoverEnvelopeSigner(wire.signed, wire.providerSig, KERNEL_A);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  test('providerAddress may differ from signerAddress (smart-wallet pattern)', async () => {
    const smart = Wallet.createRandom();
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(
      defaultPublicParams(wallet, { providerAddress: smart.address as `0x${string}` }),
    );
    expect(wire.signed.providerAddress.toLowerCase()).toBe(smart.address.toLowerCase());
    expect(wire.signed.signerAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  test('all 13 signed fields present', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(defaultPublicParams(wallet));
    // H4 fix (AIP-16 Phase 3): added smartWalletNonce → 13 fields.
    expect(Object.keys(wire.signed).sort()).toEqual(
      [
        'version',
        'txId',
        'chainId',
        'kernelAddress',
        'providerAddress',
        'signerAddress',
        'scheme',
        'providerEphemeralPubkey',
        'nonce',
        'payloadHash',
        'tag',
        'createdAt',
        'smartWalletNonce',
      ].sort(),
    );
  });
});

// ----------------------------------------------------------------------------
// buildEncrypted
// ----------------------------------------------------------------------------

describe('DeliveryEnvelopeBuilder.buildEncrypted()', () => {
  let wallet: HDNodeWallet;
  let buyerKp: ReturnType<typeof generateEphemeralKeyPair>;

  beforeEach(() => {
    wallet = Wallet.createRandom();
    buyerKp = generateEphemeralKeyPair();
  });

  afterEach(() => {
    resetSecondsNowForTests();
  });

  test('produces non-empty pubkey, nonce (12 bytes), tag (16 bytes)', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    expect(wire.signed.scheme).toBe('x25519-aes256gcm-v1');
    expect(wire.signed.providerEphemeralPubkey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(wire.signed.providerEphemeralPubkey).not.toBe(CANONICAL_EMPTY_BYTES32);
    expect(wire.signed.nonce).toMatch(/^0x[0-9a-f]{24}$/);
    expect(wire.signed.nonce).not.toBe(CANONICAL_EMPTY_BYTES12);
    expect(wire.signed.tag).toMatch(/^0x[0-9a-f]{32}$/);
    expect(wire.signed.tag).not.toBe(CANONICAL_EMPTY_BYTES16);
  });

  test('wire.body is hex-encoded ciphertext bytes', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire, bodyBytes } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    expect(wire.body).toMatch(/^0x[0-9a-f]+$/);
    expect(wire.body).toBe(bytesToHex(bodyBytes));
  });

  test('payloadHash equals bodyHash(ciphertext)', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire, bodyBytes } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    expect(wire.signed.payloadHash).toBe(bodyHash(bodyBytes));
  });

  test('returns blobKey (32-byte session key)', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const result = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    expect(result.blobKey).toBeInstanceOf(Uint8Array);
    expect(result.blobKey).toHaveLength(32);
  });

  test('encrypted roundtrip: provider encrypts → buyer derives same key → decrypts to original payload', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const payload = { greeting: 'hello', items: [1, 2, 3] };
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex, { payload }),
    );
    // Buyer side: derive session key from their private + provider's pubkey.
    const providerPub = pubkeyFromHex(wire.signed.providerEphemeralPubkey);
    const shared = deriveSharedSecret(buyerKp.privateKey, providerPub);
    const sessionKey = deriveSessionKey(shared, wire.signed.txId);
    // Decrypt manually for additional assurance.
    const ciphertext = bytesFromHex(wire.body);
    const nonce = bytesFromHex(wire.signed.nonce);
    const tag = bytesFromHex(wire.signed.tag);
    const { decryptBody } = await import('./crypto');
    // H5: builder binds GCM AAD to (txId || signerAddress). Mirror that
    // here for the manual decrypt — otherwise the tag fails to verify.
    const { buildEnvelopeAad } = await import('./envelopeBuilder');
    const aad = buildEnvelopeAad(wire.signed.txId, wire.signed.signerAddress);
    const plaintextBytes = decryptBody(ciphertext, sessionKey, nonce, tag, aad);
    const json = Buffer.from(plaintextBytes).toString('utf8');
    expect(JSON.parse(json)).toEqual(payload);
  });

  test('rejects canonical-empty buyerEphemeralPubkey', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    await expect(
      builder.buildEncrypted(defaultEncryptedParams(wallet, CANONICAL_EMPTY_BYTES32)),
    ).rejects.toMatchObject({ code: 'BUILDER_ENCRYPTED_BUYER_PUBKEY_IS_CANONICAL_EMPTY' });
  });

  test('throws BUILDER_NO_SIGNER without signer', async () => {
    const builder = new DeliveryEnvelopeBuilder();
    await expect(
      builder.buildEncrypted(defaultEncryptedParams(wallet, buyerKp.publicKeyHex)),
    ).rejects.toMatchObject({ code: 'BUILDER_NO_SIGNER' });
  });

  test('throws BUILDER_SIGNER_ADDRESS_MISMATCH on wrong signerAddress', async () => {
    const other = Wallet.createRandom();
    const builder = new DeliveryEnvelopeBuilder(wallet);
    await expect(
      builder.buildEncrypted(
        defaultEncryptedParams(wallet, buyerKp.publicKeyHex, {
          signerAddress: other.address as `0x${string}`,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUILDER_SIGNER_ADDRESS_MISMATCH' });
  });

  test('throws BUILDER_INVALID_CREATED_AT on non-positive createdAt', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    await expect(
      builder.buildEncrypted(defaultEncryptedParams(wallet, buyerKp.publicKeyHex, { createdAt: 0 })),
    ).rejects.toMatchObject({ code: 'BUILDER_INVALID_CREATED_AT' });
  });

  test('providerEphemeralKeyPair override enables deterministic-fixture testing', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const fixedKp = generateEphemeralKeyPair();
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex, {
        providerEphemeralKeyPair: fixedKp,
      }),
    );
    expect(wire.signed.providerEphemeralPubkey).toBe(pubkeyToHex(fixedKp.publicKey));
  });

  test('signature recovers to provider EOA', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    const recovered = recoverEnvelopeSigner(wire.signed, wire.providerSig, KERNEL_A);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  test('two builds produce different ciphertexts (random provider keypair + random nonce)', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire: a } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    const { wire: b } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    expect(a.body).not.toBe(b.body);
    expect(a.signed.nonce).not.toBe(b.signed.nonce);
  });
});

// ----------------------------------------------------------------------------
// verify
// ----------------------------------------------------------------------------

describe('DeliveryEnvelopeBuilder.verify()', () => {
  let wallet: HDNodeWallet;
  let publicWire: DeliveryEnvelopeWireV1;
  let encryptedWire: DeliveryEnvelopeWireV1;
  let buyerKp: ReturnType<typeof generateEphemeralKeyPair>;

  beforeEach(async () => {
    wallet = Wallet.createRandom();
    buyerKp = generateEphemeralKeyPair();
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const pub = await builder.buildPublic(defaultPublicParams(wallet));
    publicWire = pub.wire;
    const enc = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    encryptedWire = enc.wire;
  });

  afterEach(() => {
    resetSecondsNowForTests();
  });

  test('public-v1 with canonical-empty crypto fields → ok=true', () => {
    const result = DeliveryEnvelopeBuilder.verify(publicWire, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(true);
  });

  test('x25519-aes256gcm-v1 with valid crypto fields → ok=true', () => {
    const result = DeliveryEnvelopeBuilder.verify(encryptedWire, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(true);
  });

  test('public-v1 with non-empty providerEphemeralPubkey fails (canonical empty rule)', () => {
    const tampered: DeliveryEnvelopeWireV1 = {
      ...publicWire,
      signed: {
        ...publicWire.signed,
        providerEphemeralPubkey: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
      },
    };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_signature_invalid');
  });

  test('public-v1 with non-empty nonce fails', () => {
    const tampered: DeliveryEnvelopeWireV1 = {
      ...publicWire,
      signed: {
        ...publicWire.signed,
        nonce: ('0x' + 'aa'.repeat(12)) as `0x${string}`,
      },
    };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_signature_invalid');
  });

  test('public-v1 with non-empty tag fails', () => {
    const tampered: DeliveryEnvelopeWireV1 = {
      ...publicWire,
      signed: {
        ...publicWire.signed,
        tag: ('0x' + 'aa'.repeat(16)) as `0x${string}`,
      },
    };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
  });

  test('encrypted scheme with canonical-empty providerEphemeralPubkey fails', () => {
    const tampered: DeliveryEnvelopeWireV1 = {
      ...encryptedWire,
      signed: {
        ...encryptedWire.signed,
        providerEphemeralPubkey: CANONICAL_EMPTY_BYTES32,
      },
    };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
  });

  test('encrypted scheme with canonical-empty nonce fails', () => {
    const tampered: DeliveryEnvelopeWireV1 = {
      ...encryptedWire,
      signed: { ...encryptedWire.signed, nonce: CANONICAL_EMPTY_BYTES12 },
    };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
  });

  test('encrypted scheme with canonical-empty tag fails', () => {
    const tampered: DeliveryEnvelopeWireV1 = {
      ...encryptedWire,
      signed: { ...encryptedWire.signed, tag: CANONICAL_EMPTY_BYTES16 },
    };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
  });

  test('tampered body fails envelope_payload_hash_mismatch', () => {
    // FIX-1: wire.body is plaintext UTF-8 JSON for public-v1. Replace
    // it with a different valid JSON string; the recomputed
    // keccak256(utf8(body)) will diverge from signed.payloadHash.
    const tampered: DeliveryEnvelopeWireV1 = {
      ...publicWire,
      body: JSON.stringify({ tampered: true }),
    };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_payload_hash_mismatch');
  });

  test('tampered payloadHash fails signature invalid (sig commits to hash)', () => {
    const tampered: DeliveryEnvelopeWireV1 = {
      ...publicWire,
      signed: {
        ...publicWire.signed,
        payloadHash: ('0x' + 'ff'.repeat(32)) as `0x${string}`,
      },
    };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    // payloadHash mismatch fires before signature check.
    if (!result.ok) expect(result.code).toBe('envelope_payload_hash_mismatch');
  });

  test('wrong expectedKernelAddress fails envelope_kernel_mismatch', () => {
    const result = DeliveryEnvelopeBuilder.verify(publicWire, {
      expectedKernelAddress: KERNEL_B,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_kernel_mismatch');
  });

  test('wrong expectedChainId fails envelope_chain_mismatch', () => {
    const result = DeliveryEnvelopeBuilder.verify(publicWire, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: 1,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_chain_mismatch');
  });

  test('timestamp skew > 900s in past fails envelope_timestamp_skew', () => {
    const result = DeliveryEnvelopeBuilder.verify(publicWire, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW + ENVELOPE_TIMESTAMP_SKEW_SEC + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_timestamp_skew');
  });

  test('timestamp skew exactly at 900s passes', () => {
    const result = DeliveryEnvelopeBuilder.verify(publicWire, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW + ENVELOPE_TIMESTAMP_SKEW_SEC,
    });
    expect(result.ok).toBe(true);
  });

  test('tampered providerAddress fails signature invalid', () => {
    const other = Wallet.createRandom();
    const tampered: DeliveryEnvelopeWireV1 = {
      ...publicWire,
      signed: { ...publicWire.signed, providerAddress: other.address as `0x${string}` },
    };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_signature_invalid');
  });

  test('tampered signerAddress fails signature invalid', () => {
    const other = Wallet.createRandom();
    const tampered: DeliveryEnvelopeWireV1 = {
      ...publicWire,
      signed: { ...publicWire.signed, signerAddress: other.address as `0x${string}` },
    };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_signature_invalid');
  });

  test('flipping providerSig hex char fails signature invalid', () => {
    const orig = publicWire.providerSig;
    const flipped = (orig.slice(0, 3) + (orig[3] === 'a' ? 'b' : 'a') + orig.slice(4)) as `0x${string}`;
    const tampered: DeliveryEnvelopeWireV1 = { ...publicWire, providerSig: flipped };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_signature_invalid');
  });

  test('arbitrary non-matching body fails envelope_payload_hash_mismatch', () => {
    // FIX-1: for public-v1 the body is plaintext, so any byte string
    // that does not JSON-equal the signed payload diverges on the
    // recomputed hash. (For encrypted scheme the same byte string
    // would fail the hex-validation precondition with the same
    // ok=false outcome.)
    const tampered: DeliveryEnvelopeWireV1 = { ...publicWire, body: 'not-the-original-body' };
    const result = DeliveryEnvelopeBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
  });

  test('null wire fails envelope_signature_invalid', () => {
    const result = DeliveryEnvelopeBuilder.verify(null as unknown as DeliveryEnvelopeWireV1, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_signature_invalid');
  });
});

// ----------------------------------------------------------------------------
// decryptPayload
// ----------------------------------------------------------------------------

describe('DeliveryEnvelopeBuilder.decryptPayload()', () => {
  let wallet: HDNodeWallet;
  let buyerKp: ReturnType<typeof generateEphemeralKeyPair>;

  beforeEach(() => {
    wallet = Wallet.createRandom();
    buyerKp = generateEphemeralKeyPair();
  });

  test('decrypts encrypted envelope to original payload', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const payload = { secret: 'top-secret' };
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex, { payload }),
    );
    const decoded = await DeliveryEnvelopeBuilder.decryptPayload(wire, buyerKp.privateKey);
    expect(decoded).toEqual(payload);
  });

  test('throws BUILDER_PUBLIC_DECRYPT_NOT_APPLICABLE on public-v1 envelope', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(defaultPublicParams(wallet));
    await expect(
      DeliveryEnvelopeBuilder.decryptPayload(wire, buyerKp.privateKey),
    ).rejects.toBeInstanceOf(DeliveryEip712Error);
  });

  test('throws crypto_decrypt_failed on wrong buyer private key', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    const wrongKp = generateEphemeralKeyPair();
    await expect(
      DeliveryEnvelopeBuilder.decryptPayload(wire, wrongKp.privateKey),
    ).rejects.toMatchObject({ code: 'crypto_decrypt_failed' });
  });

  test('throws on tampered ciphertext bytes (GCM tag fail)', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    const len = (wire.body.length - 2) / 2;
    const tampered: DeliveryEnvelopeWireV1 = {
      ...wire,
      body: ('0x' + 'ff'.repeat(len)) as string,
    };
    await expect(
      DeliveryEnvelopeBuilder.decryptPayload(tampered, buyerKp.privateKey),
    ).rejects.toMatchObject({ code: 'crypto_decrypt_failed' });
  });

  test('throws on tampered tag', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    const tampered: DeliveryEnvelopeWireV1 = {
      ...wire,
      signed: { ...wire.signed, tag: ('0x' + 'ff'.repeat(16)) as `0x${string}` },
    };
    await expect(
      DeliveryEnvelopeBuilder.decryptPayload(tampered, buyerKp.privateKey),
    ).rejects.toMatchObject({ code: 'crypto_decrypt_failed' });
  });
});

// ----------------------------------------------------------------------------
// verifyAndDecrypt
// ----------------------------------------------------------------------------

describe('DeliveryEnvelopeBuilder.verifyAndDecrypt()', () => {
  let wallet: HDNodeWallet;
  let buyerKp: ReturnType<typeof generateEphemeralKeyPair>;

  beforeEach(() => {
    wallet = Wallet.createRandom();
    buyerKp = generateEphemeralKeyPair();
  });

  afterEach(() => {
    resetSecondsNowForTests();
  });

  test('public-v1: verify success + JSON.parse(body) returned', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const payload = { ok: 1 };
    const { wire } = await builder.buildPublic(defaultPublicParams(wallet, { payload }));
    const result = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
      wire,
      new Uint8Array(32),
      { expectedKernelAddress: KERNEL_A, expectedChainId: CHAIN_ID, now: BASE_NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });

  test('encrypted: verify success + decrypted payload returned', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const payload = { x: 'y' };
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex, { payload }),
    );
    const result = await DeliveryEnvelopeBuilder.verifyAndDecrypt(wire, buyerKp.privateKey, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });

  test('verify failure surfaces as { ok: false, code }', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(defaultPublicParams(wallet));
    const result = await DeliveryEnvelopeBuilder.verifyAndDecrypt(wire, new Uint8Array(32), {
      expectedKernelAddress: KERNEL_B,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_kernel_mismatch');
  });

  test('encrypted + wrong buyer key surfaces envelope_decrypt_failed', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildEncrypted(
      defaultEncryptedParams(wallet, buyerKp.publicKeyHex),
    );
    const wrong = generateEphemeralKeyPair();
    const result = await DeliveryEnvelopeBuilder.verifyAndDecrypt(wire, wrong.privateKey, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('envelope_decrypt_failed');
  });
});

// ----------------------------------------------------------------------------
// computeHash
// ----------------------------------------------------------------------------

describe('DeliveryEnvelopeBuilder.computeHash()', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('same input → same hash', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(defaultPublicParams(wallet));
    expect(DeliveryEnvelopeBuilder.computeHash(wire)).toBe(
      DeliveryEnvelopeBuilder.computeHash(wire),
    );
  });

  test('hash independent of providerSig + body + serverMeta', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(defaultPublicParams(wallet));
    const h1 = DeliveryEnvelopeBuilder.computeHash(wire);
    const mutated: DeliveryEnvelopeWireV1 = {
      ...wire,
      providerSig: ('0x' + 'aa'.repeat(65)) as `0x${string}`,
      body: '0xdeadbeef',
      serverMeta: { receivedAt: '2026-06-01', relayId: 'r1' },
    };
    expect(DeliveryEnvelopeBuilder.computeHash(mutated)).toBe(h1);
  });

  test('hash output is 0x + 64 lowercase hex chars', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(defaultPublicParams(wallet));
    expect(DeliveryEnvelopeBuilder.computeHash(wire)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('different signed projection → different hash', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire: a } = await builder.buildPublic(defaultPublicParams(wallet, { createdAt: BASE_NOW }));
    const { wire: b } = await builder.buildPublic(defaultPublicParams(wallet, { createdAt: BASE_NOW + 1 }));
    expect(DeliveryEnvelopeBuilder.computeHash(a)).not.toBe(
      DeliveryEnvelopeBuilder.computeHash(b),
    );
  });
});
