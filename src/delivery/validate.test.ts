/**
 * AIP-16 Delivery Surface — runtime validation unit tests.
 *
 * Covers:
 *  - Primitive validators (bytes32/16/12, address, uintString, scheme,
 *    privacy, role): each accepts 3 valid inputs and rejects 3 distinct
 *    classes of malformed input.
 *  - Canonical-empty checks: exact-match on zero-filled, rejects any
 *    non-zero variant.
 *  - validateSetupSigned: valid object → ok; each individual field
 *    missing or mistyped → specific snake_case error code.
 *  - validateEnvelopeSigned: same coverage, plus scheme/canonical-empty
 *    cross-field check.
 *  - validateSchemeConsistency: public-v1 vs x25519-aes256gcm-v1, each
 *    branch of the rule (both directions).
 *  - validateSetupWire / validateEnvelopeWire: pass on valid, fail on
 *    missing signature, missing body, malformed serverMeta.
 *  - Expired setup: `expiresAt < createdAt` → `expiresAt_before_createdAt`.
 *
 * No mocks; pure value-level assertions.
 */

import {
  CANONICAL_EMPTY_BYTES12,
  CANONICAL_EMPTY_BYTES16,
  CANONICAL_EMPTY_BYTES32,
  type DeliveryEnvelopeSignedV1,
  type DeliveryEnvelopeWireV1,
  type DeliverySetupSignedV1,
  type DeliverySetupWireV1,
} from './types';
import {
  isCanonicalEmptyBytes12,
  isCanonicalEmptyBytes16,
  isCanonicalEmptyBytes32,
  isValidAddress,
  isValidBytes12,
  isValidBytes16,
  isValidBytes32,
  isValidPrivacy,
  isValidRole,
  isValidScheme,
  isValidUintString,
  validateEnvelopeSigned,
  validateEnvelopeWire,
  validateSchemeConsistency,
  validateSetupSigned,
  validateSetupWire,
} from './validate';

const VALID_ADDR_1 = '0x469CBADbACFFE096270594F0a31f0EEC53753411';
const VALID_ADDR_2 = '0x57f888261b629bB380dfb983f5DA6c70Ff2D49E5';
const VALID_ADDR_3 = '0x6aAF45882c4b0dD34130ecC790bb5Ec6be7fFb99';
const VALID_BYTES32_A = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const VALID_BYTES32_B = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
const VALID_BYTES12_A = ('0x' + '11'.repeat(12)) as `0x${string}`;
const VALID_BYTES16_A = ('0x' + '22'.repeat(16)) as `0x${string}`;
const VALID_SIG = ('0x' + 'cd'.repeat(65)) as `0x${string}`;

function expectFail(result: { ok: boolean }, expectedError: string): void {
  expect(result.ok).toBe(false);
  expect((result as { ok: false; error: string }).error).toBe(expectedError);
}

function expectOk(result: { ok: boolean }): void {
  expect(result.ok).toBe(true);
}

function validSetup(overrides: Partial<DeliverySetupSignedV1> = {}): DeliverySetupSignedV1 {
  return {
    version: 1,
    txId: VALID_BYTES32_A,
    chainId: 84532,
    kernelAddress: VALID_ADDR_1 as `0x${string}`,
    requesterAddress: VALID_ADDR_2 as `0x${string}`,
    signerAddress: VALID_ADDR_3 as `0x${string}`,
    buyerEphemeralPubkey: VALID_BYTES32_B,
    acceptedChannels: ['agirails-relay-v1'],
    expectedPrivacy: 'encrypted',
    createdAt: 1_730_000_000,
    expiresAt: 1_730_000_600,
    ...overrides,
  };
}

function validEncryptedEnvelope(
  overrides: Partial<DeliveryEnvelopeSignedV1> = {},
): DeliveryEnvelopeSignedV1 {
  return {
    version: 1,
    txId: VALID_BYTES32_A,
    chainId: 84532,
    kernelAddress: VALID_ADDR_1 as `0x${string}`,
    providerAddress: VALID_ADDR_2 as `0x${string}`,
    signerAddress: VALID_ADDR_3 as `0x${string}`,
    scheme: 'x25519-aes256gcm-v1',
    providerEphemeralPubkey: VALID_BYTES32_B,
    nonce: VALID_BYTES12_A,
    payloadHash: ('0x' + '33'.repeat(32)) as `0x${string}`,
    tag: VALID_BYTES16_A,
    createdAt: 1_730_000_100,
    ...overrides,
  };
}

function validPublicEnvelope(
  overrides: Partial<DeliveryEnvelopeSignedV1> = {},
): DeliveryEnvelopeSignedV1 {
  return {
    version: 1,
    txId: VALID_BYTES32_A,
    chainId: 84532,
    kernelAddress: VALID_ADDR_1 as `0x${string}`,
    providerAddress: VALID_ADDR_2 as `0x${string}`,
    signerAddress: VALID_ADDR_3 as `0x${string}`,
    scheme: 'public-v1',
    providerEphemeralPubkey: CANONICAL_EMPTY_BYTES32,
    nonce: CANONICAL_EMPTY_BYTES12,
    payloadHash: ('0x' + '44'.repeat(32)) as `0x${string}`,
    tag: CANONICAL_EMPTY_BYTES16,
    createdAt: 1_730_000_100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

describe('delivery/validate — isValidBytes32', () => {
  it('accepts canonical bytes32 (lowercase)', () => {
    expect(isValidBytes32('0x' + 'ab'.repeat(32))).toBe(true);
  });
  it('accepts uppercase hex bytes32', () => {
    expect(isValidBytes32('0x' + 'AB'.repeat(32))).toBe(true);
  });
  it('accepts all-zero bytes32 (CANONICAL_EMPTY_BYTES32)', () => {
    expect(isValidBytes32(CANONICAL_EMPTY_BYTES32)).toBe(true);
  });
  it('rejects bytes32 missing 0x prefix', () => {
    expect(isValidBytes32('ab'.repeat(32))).toBe(false);
  });
  it('rejects bytes32 of wrong length', () => {
    expect(isValidBytes32('0x' + 'ab'.repeat(16))).toBe(false);
  });
  it('rejects bytes32 with non-hex char', () => {
    expect(isValidBytes32('0x' + 'zz' + 'ab'.repeat(31))).toBe(false);
  });
  it('rejects non-string inputs', () => {
    expect(isValidBytes32(undefined)).toBe(false);
    expect(isValidBytes32(123)).toBe(false);
  });
});

describe('delivery/validate — isValidBytes12', () => {
  it('accepts canonical 12-byte hex', () => {
    expect(isValidBytes12('0x' + '11'.repeat(12))).toBe(true);
  });
  it('accepts uppercase hex bytes12', () => {
    expect(isValidBytes12('0x' + 'AA'.repeat(12))).toBe(true);
  });
  it('accepts CANONICAL_EMPTY_BYTES12', () => {
    expect(isValidBytes12(CANONICAL_EMPTY_BYTES12)).toBe(true);
  });
  it('rejects bytes12 missing 0x prefix', () => {
    expect(isValidBytes12('11'.repeat(12))).toBe(false);
  });
  it('rejects bytes12 of wrong length', () => {
    expect(isValidBytes12('0x' + '11'.repeat(8))).toBe(false);
  });
  it('rejects bytes12 with non-hex char', () => {
    expect(isValidBytes12('0x' + 'gg'.repeat(12))).toBe(false);
  });
});

describe('delivery/validate — isValidBytes16', () => {
  it('accepts canonical 16-byte hex', () => {
    expect(isValidBytes16('0x' + '22'.repeat(16))).toBe(true);
  });
  it('accepts CANONICAL_EMPTY_BYTES16', () => {
    expect(isValidBytes16(CANONICAL_EMPTY_BYTES16)).toBe(true);
  });
  it('accepts uppercase hex bytes16', () => {
    expect(isValidBytes16('0x' + 'CD'.repeat(16))).toBe(true);
  });
  it('rejects bytes16 of wrong length', () => {
    expect(isValidBytes16('0x' + '22'.repeat(8))).toBe(false);
  });
  it('rejects bytes16 missing 0x prefix', () => {
    expect(isValidBytes16('22'.repeat(16))).toBe(false);
  });
  it('rejects bytes16 with non-hex char', () => {
    expect(isValidBytes16('0x' + '!!'.repeat(16))).toBe(false);
  });
});

describe('delivery/validate — isValidAddress', () => {
  it('accepts a known valid EVM address', () => {
    expect(isValidAddress(VALID_ADDR_1)).toBe(true);
  });
  it('accepts a second valid EVM address', () => {
    expect(isValidAddress(VALID_ADDR_2)).toBe(true);
  });
  it('accepts an all-lowercase valid address', () => {
    expect(isValidAddress(VALID_ADDR_1.toLowerCase())).toBe(true);
  });
  it('rejects a short string', () => {
    expect(isValidAddress('0x123')).toBe(false);
  });
  it('rejects a non-hex string', () => {
    expect(isValidAddress('not-an-address')).toBe(false);
  });
  it('rejects a non-string', () => {
    expect(isValidAddress(undefined)).toBe(false);
    expect(isValidAddress(42)).toBe(false);
  });
});

describe('delivery/validate — isValidUintString', () => {
  it('accepts "0"', () => {
    expect(isValidUintString('0')).toBe(true);
  });
  it('accepts a positive integer string', () => {
    expect(isValidUintString('1234567890')).toBe(true);
  });
  it('accepts a large uint256-shaped string', () => {
    expect(
      isValidUintString('115792089237316195423570985008687907853269984665640564039457584007913129639935'),
    ).toBe(true);
  });
  it('rejects strings with a leading zero (other than "0")', () => {
    expect(isValidUintString('01')).toBe(false);
  });
  it('rejects negative-signed strings', () => {
    expect(isValidUintString('-1')).toBe(false);
  });
  it('rejects non-numeric strings', () => {
    expect(isValidUintString('twelve')).toBe(false);
  });
});

describe('delivery/validate — isValidScheme', () => {
  it('accepts "x25519-aes256gcm-v1"', () => {
    expect(isValidScheme('x25519-aes256gcm-v1')).toBe(true);
  });
  it('accepts "public-v1"', () => {
    expect(isValidScheme('public-v1')).toBe(true);
  });
  it('rejects unknown scheme', () => {
    expect(isValidScheme('chacha20-poly1305-v1')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isValidScheme('')).toBe(false);
  });
});

describe('delivery/validate — isValidPrivacy', () => {
  it('accepts "encrypted"', () => {
    expect(isValidPrivacy('encrypted')).toBe(true);
  });
  it('accepts "public"', () => {
    expect(isValidPrivacy('public')).toBe(true);
  });
  it('rejects unknown privacy', () => {
    expect(isValidPrivacy('private')).toBe(false);
  });
  it('rejects non-string', () => {
    expect(isValidPrivacy(undefined)).toBe(false);
  });
});

describe('delivery/validate — isValidRole', () => {
  it('accepts "provider"', () => {
    expect(isValidRole('provider')).toBe(true);
  });
  it('accepts "requester"', () => {
    expect(isValidRole('requester')).toBe(true);
  });
  it('rejects unknown role', () => {
    expect(isValidRole('relay')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Canonical-empty checks
// ---------------------------------------------------------------------------

describe('delivery/validate — canonical-empty checks', () => {
  it('isCanonicalEmptyBytes32 accepts CANONICAL_EMPTY_BYTES32', () => {
    expect(isCanonicalEmptyBytes32(CANONICAL_EMPTY_BYTES32)).toBe(true);
  });
  it('isCanonicalEmptyBytes32 accepts upper-case zeros (case-insensitive)', () => {
    expect(isCanonicalEmptyBytes32('0X' + '00'.repeat(32))).toBe(true);
  });
  it('isCanonicalEmptyBytes32 rejects a single non-zero byte', () => {
    expect(isCanonicalEmptyBytes32('0x01' + '00'.repeat(31))).toBe(false);
  });
  it('isCanonicalEmptyBytes32 rejects wrong length', () => {
    expect(isCanonicalEmptyBytes32('0x' + '00'.repeat(16))).toBe(false);
  });
  it('isCanonicalEmptyBytes12 accepts CANONICAL_EMPTY_BYTES12', () => {
    expect(isCanonicalEmptyBytes12(CANONICAL_EMPTY_BYTES12)).toBe(true);
  });
  it('isCanonicalEmptyBytes12 rejects non-zero', () => {
    expect(isCanonicalEmptyBytes12('0x' + 'ff'.repeat(12))).toBe(false);
  });
  it('isCanonicalEmptyBytes16 accepts CANONICAL_EMPTY_BYTES16', () => {
    expect(isCanonicalEmptyBytes16(CANONICAL_EMPTY_BYTES16)).toBe(true);
  });
  it('isCanonicalEmptyBytes16 rejects non-zero', () => {
    expect(isCanonicalEmptyBytes16('0x' + '01'.repeat(16))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateSetupSigned
// ---------------------------------------------------------------------------

describe('delivery/validate — validateSetupSigned', () => {
  it('accepts a complete valid setup', () => {
    expectOk(validateSetupSigned(validSetup()));
  });

  it('rejects non-object', () => {
    expectFail(validateSetupSigned('not an object'), 'setup_signed_not_object');
    expectFail(validateSetupSigned(null), 'setup_signed_not_object');
    expectFail(validateSetupSigned([]), 'setup_signed_not_object');
  });

  it('rejects version !== 1', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), version: 2 as unknown as 1 }),
      'setup_version_invalid',
    );
  });

  it('rejects malformed txId', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), txId: '0xshort' as `0x${string}` }),
      'setup_txid_invalid',
    );
  });

  it('rejects non-integer chainId', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), chainId: 1.5 }),
      'setup_chain_id_invalid',
    );
  });

  it('rejects negative chainId', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), chainId: -1 }),
      'setup_chain_id_invalid',
    );
  });

  it('rejects malformed kernelAddress', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), kernelAddress: 'not addr' as `0x${string}` }),
      'setup_kernel_address_invalid',
    );
  });

  it('rejects malformed requesterAddress', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), requesterAddress: '0xnope' as `0x${string}` }),
      'setup_requester_address_invalid',
    );
  });

  it('rejects malformed signerAddress', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), signerAddress: '0xnope' as `0x${string}` }),
      'setup_signer_address_invalid',
    );
  });

  it('rejects malformed buyerEphemeralPubkey', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), buyerEphemeralPubkey: '0xabc' as `0x${string}` }),
      'setup_buyer_pubkey_invalid',
    );
  });

  it('rejects empty acceptedChannels array', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), acceptedChannels: [] }),
      'setup_accepted_channels_invalid',
    );
  });

  it('rejects acceptedChannels with non-string entry', () => {
    expectFail(
      validateSetupSigned({
        ...validSetup(),
        acceptedChannels: [123 as unknown as string],
      }),
      'setup_accepted_channels_invalid',
    );
  });

  it('rejects malformed expectedPrivacy', () => {
    expectFail(
      validateSetupSigned({
        ...validSetup(),
        expectedPrivacy: 'private' as unknown as 'public',
      }),
      'setup_expected_privacy_invalid',
    );
  });

  it('rejects non-integer createdAt', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), createdAt: 1.5 }),
      'setup_created_at_invalid',
    );
  });

  it('rejects non-integer expiresAt', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), expiresAt: NaN }),
      'setup_expires_at_invalid',
    );
  });

  it('rejects expired setup (expiresAt < createdAt)', () => {
    expectFail(
      validateSetupSigned({
        ...validSetup(),
        createdAt: 2_000_000_000,
        expiresAt: 1_999_999_000,
      }),
      'expiresAt_before_createdAt',
    );
  });

  it('rejects expiresAt === createdAt (must be strictly after)', () => {
    expectFail(
      validateSetupSigned({ ...validSetup(), createdAt: 1_730_000_000, expiresAt: 1_730_000_000 }),
      'expiresAt_before_createdAt',
    );
  });

  it('accepts "public" expectedPrivacy paired with non-empty pubkey (per-setup-side rule lives in verifier)', () => {
    // validateSetupSigned does not enforce setup-side canonical-empty (per
    // module-level docstring). The verifier in Phase 2b does.
    expectOk(
      validateSetupSigned({
        ...validSetup(),
        expectedPrivacy: 'public',
        buyerEphemeralPubkey: VALID_BYTES32_B,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// validateEnvelopeSigned
// ---------------------------------------------------------------------------

describe('delivery/validate — validateEnvelopeSigned', () => {
  it('accepts a valid encrypted envelope', () => {
    expectOk(validateEnvelopeSigned(validEncryptedEnvelope()));
  });

  it('accepts a valid public envelope', () => {
    expectOk(validateEnvelopeSigned(validPublicEnvelope()));
  });

  it('rejects non-object', () => {
    expectFail(validateEnvelopeSigned(null), 'envelope_signed_not_object');
  });

  it('rejects version !== 1', () => {
    expectFail(
      validateEnvelopeSigned({ ...validEncryptedEnvelope(), version: 0 as unknown as 1 }),
      'envelope_version_invalid',
    );
  });

  it('rejects malformed txId', () => {
    expectFail(
      validateEnvelopeSigned({ ...validEncryptedEnvelope(), txId: '0x' as `0x${string}` }),
      'envelope_txid_invalid',
    );
  });

  it('rejects non-positive chainId', () => {
    expectFail(
      validateEnvelopeSigned({ ...validEncryptedEnvelope(), chainId: 0 }),
      'envelope_chain_id_invalid',
    );
  });

  it('rejects malformed kernelAddress', () => {
    expectFail(
      validateEnvelopeSigned({
        ...validEncryptedEnvelope(),
        kernelAddress: '0xbad' as `0x${string}`,
      }),
      'envelope_kernel_address_invalid',
    );
  });

  it('rejects malformed providerAddress', () => {
    expectFail(
      validateEnvelopeSigned({
        ...validEncryptedEnvelope(),
        providerAddress: '' as `0x${string}`,
      }),
      'envelope_provider_address_invalid',
    );
  });

  it('rejects malformed signerAddress', () => {
    expectFail(
      validateEnvelopeSigned({
        ...validEncryptedEnvelope(),
        signerAddress: 'nope' as `0x${string}`,
      }),
      'envelope_signer_address_invalid',
    );
  });

  it('rejects unknown scheme', () => {
    expectFail(
      validateEnvelopeSigned({
        ...validEncryptedEnvelope(),
        scheme: 'made-up-v1' as unknown as 'public-v1',
      }),
      'envelope_scheme_invalid',
    );
  });

  it('rejects malformed providerEphemeralPubkey', () => {
    expectFail(
      validateEnvelopeSigned({
        ...validEncryptedEnvelope(),
        providerEphemeralPubkey: '0xshort' as `0x${string}`,
      }),
      'envelope_provider_pubkey_invalid',
    );
  });

  it('rejects malformed nonce (wrong length)', () => {
    expectFail(
      validateEnvelopeSigned({
        ...validEncryptedEnvelope(),
        nonce: ('0x' + '11'.repeat(8)) as `0x${string}`,
      }),
      'envelope_nonce_invalid',
    );
  });

  it('rejects malformed payloadHash', () => {
    expectFail(
      validateEnvelopeSigned({
        ...validEncryptedEnvelope(),
        payloadHash: '0xbad' as `0x${string}`,
      }),
      'envelope_payload_hash_invalid',
    );
  });

  it('rejects malformed tag (wrong length)', () => {
    expectFail(
      validateEnvelopeSigned({
        ...validEncryptedEnvelope(),
        tag: ('0x' + '22'.repeat(8)) as `0x${string}`,
      }),
      'envelope_tag_invalid',
    );
  });

  it('rejects non-integer createdAt', () => {
    expectFail(
      validateEnvelopeSigned({ ...validEncryptedEnvelope(), createdAt: -1 }),
      'envelope_created_at_invalid',
    );
  });

  it('rejects public-v1 with non-empty providerEphemeralPubkey', () => {
    expectFail(
      validateEnvelopeSigned({
        ...validPublicEnvelope(),
        providerEphemeralPubkey: VALID_BYTES32_B,
      }),
      'envelope_public_pubkey_not_canonical_empty',
    );
  });

  it('rejects encrypted scheme with all-zero providerEphemeralPubkey', () => {
    expectFail(
      validateEnvelopeSigned({
        ...validEncryptedEnvelope(),
        providerEphemeralPubkey: CANONICAL_EMPTY_BYTES32,
      }),
      'envelope_encrypted_pubkey_is_canonical_empty',
    );
  });
});

// ---------------------------------------------------------------------------
// validateSchemeConsistency
// ---------------------------------------------------------------------------

describe('delivery/validate — validateSchemeConsistency', () => {
  it('public-v1 with canonical-empty crypto fields → ok', () => {
    expectOk(validateSchemeConsistency(validPublicEnvelope()));
  });

  it('public-v1 with non-empty providerEphemeralPubkey → envelope_public_pubkey_not_canonical_empty', () => {
    expectFail(
      validateSchemeConsistency(
        validPublicEnvelope({ providerEphemeralPubkey: VALID_BYTES32_B }),
      ),
      'envelope_public_pubkey_not_canonical_empty',
    );
  });

  it('public-v1 with non-empty nonce → envelope_public_nonce_not_canonical_empty', () => {
    expectFail(
      validateSchemeConsistency(validPublicEnvelope({ nonce: VALID_BYTES12_A })),
      'envelope_public_nonce_not_canonical_empty',
    );
  });

  it('public-v1 with non-empty tag → envelope_public_tag_not_canonical_empty', () => {
    expectFail(
      validateSchemeConsistency(validPublicEnvelope({ tag: VALID_BYTES16_A })),
      'envelope_public_tag_not_canonical_empty',
    );
  });

  it('x25519-aes256gcm-v1 with non-empty providerEphemeralPubkey → ok', () => {
    expectOk(validateSchemeConsistency(validEncryptedEnvelope()));
  });

  it('x25519-aes256gcm-v1 with canonical-empty pubkey → envelope_encrypted_pubkey_is_canonical_empty', () => {
    expectFail(
      validateSchemeConsistency(
        validEncryptedEnvelope({ providerEphemeralPubkey: CANONICAL_EMPTY_BYTES32 }),
      ),
      'envelope_encrypted_pubkey_is_canonical_empty',
    );
  });

  it('x25519-aes256gcm-v1 with canonical-empty nonce → envelope_encrypted_nonce_is_canonical_empty', () => {
    expectFail(
      validateSchemeConsistency(validEncryptedEnvelope({ nonce: CANONICAL_EMPTY_BYTES12 })),
      'envelope_encrypted_nonce_is_canonical_empty',
    );
  });

  it('x25519-aes256gcm-v1 with canonical-empty tag → envelope_encrypted_tag_is_canonical_empty', () => {
    expectFail(
      validateSchemeConsistency(validEncryptedEnvelope({ tag: CANONICAL_EMPTY_BYTES16 })),
      'envelope_encrypted_tag_is_canonical_empty',
    );
  });

  it('unknown scheme value → envelope_scheme_invalid', () => {
    expectFail(
      validateSchemeConsistency({
        ...validEncryptedEnvelope(),
        scheme: 'rot13-v1' as unknown as 'public-v1',
      }),
      'envelope_scheme_invalid',
    );
  });
});

// ---------------------------------------------------------------------------
// validateSetupWire
// ---------------------------------------------------------------------------

describe('delivery/validate — validateSetupWire', () => {
  function validSetupWire(): DeliverySetupWireV1 {
    return {
      signed: validSetup(),
      requesterSig: VALID_SIG,
    };
  }

  it('accepts a valid setup wire', () => {
    expectOk(validateSetupWire(validSetupWire()));
  });

  it('rejects non-object', () => {
    expectFail(validateSetupWire(null), 'setup_wire_not_object');
  });

  it('propagates an inner signed-validation failure', () => {
    const wire = validSetupWire();
    expectFail(
      validateSetupWire({ ...wire, signed: { ...wire.signed, version: 9 as unknown as 1 } }),
      'setup_version_invalid',
    );
  });

  it('rejects missing requesterSig', () => {
    const wire = validSetupWire();
    const broken = { ...wire, requesterSig: undefined } as unknown as DeliverySetupWireV1;
    expectFail(validateSetupWire(broken), 'setup_requester_sig_invalid');
  });

  it('rejects malformed requesterSig (too short)', () => {
    expectFail(
      validateSetupWire({ ...validSetupWire(), requesterSig: '0xabc' as `0x${string}` }),
      'setup_requester_sig_invalid',
    );
  });

  it('accepts serverMeta when both subfields are non-empty strings', () => {
    expectOk(
      validateSetupWire({
        ...validSetupWire(),
        serverMeta: { receivedAt: '2026-06-05T00:00:00Z', relayId: 'agirails-relay-v1' },
      }),
    );
  });

  it('rejects serverMeta with empty receivedAt', () => {
    expectFail(
      validateSetupWire({
        ...validSetupWire(),
        serverMeta: { receivedAt: '', relayId: 'r' },
      }),
      'setup_server_meta_received_at_invalid',
    );
  });

  it('rejects serverMeta with empty relayId', () => {
    expectFail(
      validateSetupWire({
        ...validSetupWire(),
        serverMeta: { receivedAt: 'ts', relayId: '' },
      }),
      'setup_server_meta_relay_id_invalid',
    );
  });
});

// ---------------------------------------------------------------------------
// validateEnvelopeWire
// ---------------------------------------------------------------------------

describe('delivery/validate — validateEnvelopeWire', () => {
  function validEnvelopeWire(): DeliveryEnvelopeWireV1 {
    return {
      signed: validEncryptedEnvelope(),
      body: 'base64ciphertext==',
      providerSig: VALID_SIG,
    };
  }

  it('accepts a valid envelope wire', () => {
    expectOk(validateEnvelopeWire(validEnvelopeWire()));
  });

  it('rejects non-object', () => {
    expectFail(validateEnvelopeWire('nope'), 'envelope_wire_not_object');
  });

  it('propagates an inner signed-validation failure', () => {
    const wire = validEnvelopeWire();
    expectFail(
      validateEnvelopeWire({
        ...wire,
        signed: { ...wire.signed, scheme: 'rot13-v1' as unknown as 'public-v1' },
      }),
      'envelope_scheme_invalid',
    );
  });

  it('rejects empty body string', () => {
    expectFail(
      validateEnvelopeWire({ ...validEnvelopeWire(), body: '' }),
      'envelope_body_invalid',
    );
  });

  it('rejects missing body', () => {
    const wire = validEnvelopeWire();
    const broken = { ...wire, body: undefined } as unknown as DeliveryEnvelopeWireV1;
    expectFail(validateEnvelopeWire(broken), 'envelope_body_invalid');
  });

  it('rejects malformed providerSig', () => {
    expectFail(
      validateEnvelopeWire({
        ...validEnvelopeWire(),
        providerSig: '0xshort' as `0x${string}`,
      }),
      'envelope_provider_sig_invalid',
    );
  });

  it('accepts serverMeta with valid subfields', () => {
    expectOk(
      validateEnvelopeWire({
        ...validEnvelopeWire(),
        serverMeta: { receivedAt: '2026-06-05T00:00:00Z', relayId: 'agirails-relay-v1' },
      }),
    );
  });

  it('rejects serverMeta that is not an object', () => {
    expectFail(
      validateEnvelopeWire({
        ...validEnvelopeWire(),
        serverMeta: 'string' as unknown as DeliveryEnvelopeWireV1['serverMeta'],
      }),
      'envelope_server_meta_invalid',
    );
  });
});
