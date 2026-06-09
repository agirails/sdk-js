/**
 * Unit tests for DeliverySetupBuilder (AIP-16 Phase 2b).
 *
 * Covers: build() happy path + all preflight throws, verify() positive
 * + every adversarial path (tampered signature, tampered fields, wrong
 * kernel, wrong chainId, timestamp skew, expiry), computeHash()
 * stability, NonceManager interaction, and EIP-712 raw interop via
 * ethers.verifyTypedData.
 */

import { ethers, HDNodeWallet, Wallet } from 'ethers';

import type { NonceManager } from '../utils/NonceManager';

import {
  DELIVERY_SETUP_TYPES_V1,
  DeliveryEip712Error,
  buildDeliveryDomain,
} from './eip712';
import { DELIVERY_NONCE_KEY_SETUP } from './nonce-keys';
import {
  DEFAULT_ACCEPTED_CHANNELS,
  DEFAULT_SETUP_EXPIRY_SEC,
  DeliverySetupBuilder,
  SETUP_TIMESTAMP_SKEW_SEC,
  resetSecondsNowForTests,
  setSecondsNowForTests,
  type BuildSetupParams,
} from './setupBuilder';
import {
  CANONICAL_EMPTY_BYTES32,
  type DeliverySetupSignedV1,
  type DeliverySetupWireV1,
} from './types';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const KERNEL_A = '0x469CBADbACFFE096270594F0a31f0EEC53753411';
const KERNEL_B = '0x132B9eB321dBB57c828B083844287171BDC92d29';
const CHAIN_ID = 84532;
const BASE_NOW = 1_750_000_000;
const TX_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const BUYER_PUBKEY_NON_EMPTY = ('0x' + 'cd'.repeat(32)) as `0x${string}`;

/** Mock NonceManager that records keys touched. */
class TrackingNonceManager implements NonceManager {
  public calls: Array<{ method: string; key: string; value?: number }> = [];
  private counters = new Map<string, number>();
  getNextNonce(messageType: string): number {
    this.calls.push({ method: 'getNextNonce', key: messageType });
    const next = (this.counters.get(messageType) ?? 0) + 1;
    this.counters.set(messageType, next);
    return next;
  }
  recordNonce(messageType: string, nonce: number): void {
    this.calls.push({ method: 'recordNonce', key: messageType, value: nonce });
  }
  getCurrentNonce(messageType: string): number {
    return this.counters.get(messageType) ?? 0;
  }
  resetNonce(messageType: string): void {
    this.counters.delete(messageType);
  }
}

/** Build a default valid params object using `wallet` as the EOA. */
function defaultParams(
  wallet: HDNodeWallet,
  overrides: Partial<BuildSetupParams> = {},
): BuildSetupParams {
  return {
    txId: TX_ID,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL_A as `0x${string}`,
    requesterAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    buyerEphemeralPubkey: BUYER_PUBKEY_NON_EMPTY,
    expectedPrivacy: 'encrypted',
    createdAt: BASE_NOW,
    expiresInSec: 600,
    ...overrides,
  };
}

async function buildValidWire(
  wallet: HDNodeWallet,
  overrides: Partial<BuildSetupParams> = {},
): Promise<DeliverySetupWireV1> {
  const builder = new DeliverySetupBuilder(wallet);
  const { wire } = await builder.build(defaultParams(wallet, overrides));
  return wire;
}

// ----------------------------------------------------------------------------
// build()
// ----------------------------------------------------------------------------

describe('DeliverySetupBuilder.build()', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  afterEach(() => {
    resetSecondsNowForTests();
  });

  test('returns wire with all expected fields populated', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    const { wire, nonceManagerKey } = await builder.build(defaultParams(wallet));

    expect(wire.signed.version).toBe(1);
    expect(wire.signed.txId).toBe(TX_ID);
    expect(wire.signed.chainId).toBe(CHAIN_ID);
    expect(wire.signed.kernelAddress.toLowerCase()).toBe(KERNEL_A.toLowerCase());
    expect(wire.signed.requesterAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(wire.signed.signerAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(wire.signed.buyerEphemeralPubkey).toBe(BUYER_PUBKEY_NON_EMPTY);
    expect(wire.signed.expectedPrivacy).toBe('encrypted');
    expect(wire.signed.createdAt).toBe(BASE_NOW);
    expect(wire.signed.expiresAt).toBe(BASE_NOW + 600);
    expect(wire.requesterSig).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(nonceManagerKey).toBe(DELIVERY_NONCE_KEY_SETUP);
  });

  test('throws BUILDER_NO_SIGNER when constructed without a signer', async () => {
    const builder = new DeliverySetupBuilder();
    await expect(builder.build(defaultParams(wallet))).rejects.toBeInstanceOf(
      DeliveryEip712Error,
    );
    try {
      await new DeliverySetupBuilder().build(defaultParams(wallet));
    } catch (e) {
      expect((e as DeliveryEip712Error).code).toBe('BUILDER_NO_SIGNER');
    }
  });

  test('throws BUILDER_SIGNER_ADDRESS_MISMATCH when params.signerAddress != signer EOA', async () => {
    const other = Wallet.createRandom();
    const builder = new DeliverySetupBuilder(wallet);
    await expect(
      builder.build(defaultParams(wallet, { signerAddress: other.address as `0x${string}` })),
    ).rejects.toMatchObject({ code: 'BUILDER_SIGNER_ADDRESS_MISMATCH' });
  });

  test('signerAddress comparison is case-insensitive', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    // Preserve `0x` prefix case; only flip the hex digits. Otherwise ethers
    // misinterprets `0XABCD…` as an ENS name to resolve.
    const upper = ('0x' + wallet.address.slice(2).toUpperCase()) as `0x${string}`;
    await expect(
      builder.build(defaultParams(wallet, { signerAddress: upper })),
    ).resolves.toBeDefined();
  });

  test('defaults applied for expiresInSec (DEFAULT_SETUP_EXPIRY_SEC)', async () => {
    setSecondsNowForTests(() => BASE_NOW);
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build({
      ...defaultParams(wallet),
      expiresInSec: undefined,
    });
    expect(wire.signed.expiresAt).toBe(BASE_NOW + DEFAULT_SETUP_EXPIRY_SEC);
  });

  test('defaults applied for acceptedChannels (DEFAULT_ACCEPTED_CHANNELS)', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build(defaultParams(wallet));
    expect(wire.signed.acceptedChannels).toEqual([...DEFAULT_ACCEPTED_CHANNELS]);
  });

  test('custom acceptedChannels honored', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    const custom = ['agirails-relay-v1', 'libp2p://test'];
    const { wire } = await builder.build(defaultParams(wallet, { acceptedChannels: custom }));
    expect(wire.signed.acceptedChannels).toEqual(custom);
  });

  test('createdAt default falls through secondsNow() seam', async () => {
    setSecondsNowForTests(() => 1_800_000_000);
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build({
      ...defaultParams(wallet),
      createdAt: undefined,
    });
    expect(wire.signed.createdAt).toBe(1_800_000_000);
    expect(wire.signed.expiresAt).toBe(1_800_000_000 + 600);
  });

  test('custom expiresInSec honored', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build(defaultParams(wallet, { expiresInSec: 7200 }));
    expect(wire.signed.expiresAt).toBe(BASE_NOW + 7200);
  });

  test('public privacy + CANONICAL_EMPTY_BYTES32 buyerEphemeralPubkey allowed', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build(
      defaultParams(wallet, {
        expectedPrivacy: 'public',
        buyerEphemeralPubkey: CANONICAL_EMPTY_BYTES32,
      }),
    );
    expect(wire.signed.expectedPrivacy).toBe('public');
    expect(wire.signed.buyerEphemeralPubkey).toBe(CANONICAL_EMPTY_BYTES32);
  });

  test('public privacy + non-empty pubkey throws BUILDER_PUBLIC_PUBKEY_NOT_CANONICAL_EMPTY', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    await expect(
      builder.build(
        defaultParams(wallet, {
          expectedPrivacy: 'public',
          buyerEphemeralPubkey: BUYER_PUBKEY_NON_EMPTY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUILDER_PUBLIC_PUBKEY_NOT_CANONICAL_EMPTY' });
  });

  test('encrypted privacy + canonical-empty pubkey throws BUILDER_ENCRYPTED_PUBKEY_IS_CANONICAL_EMPTY', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    await expect(
      builder.build(
        defaultParams(wallet, {
          expectedPrivacy: 'encrypted',
          buyerEphemeralPubkey: CANONICAL_EMPTY_BYTES32,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUILDER_ENCRYPTED_PUBKEY_IS_CANONICAL_EMPTY' });
  });

  test('encrypted privacy + buyerEphemeralPubkey written verbatim (case preserved)', async () => {
    const upperPub = ('0x' + 'DE'.repeat(32)) as `0x${string}`;
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build(
      defaultParams(wallet, { buyerEphemeralPubkey: upperPub }),
    );
    expect(wire.signed.buyerEphemeralPubkey).toBe(upperPub);
  });

  test('throws BUILDER_INVALID_EXPIRES_IN for zero expiresInSec', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    await expect(builder.build(defaultParams(wallet, { expiresInSec: 0 }))).rejects.toMatchObject(
      { code: 'BUILDER_INVALID_EXPIRES_IN' },
    );
  });

  test('throws BUILDER_INVALID_EXPIRES_IN for negative expiresInSec', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    await expect(builder.build(defaultParams(wallet, { expiresInSec: -1 }))).rejects.toMatchObject(
      { code: 'BUILDER_INVALID_EXPIRES_IN' },
    );
  });

  test('throws BUILDER_INVALID_EXPIRES_IN for non-integer expiresInSec', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    await expect(
      builder.build(defaultParams(wallet, { expiresInSec: 1.5 })),
    ).rejects.toMatchObject({ code: 'BUILDER_INVALID_EXPIRES_IN' });
  });

  test('throws BUILDER_INVALID_CREATED_AT for negative createdAt', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    await expect(builder.build(defaultParams(wallet, { createdAt: -1 }))).rejects.toMatchObject({
      code: 'BUILDER_INVALID_CREATED_AT',
    });
  });

  test('throws BUILDER_INVALID_CREATED_AT for zero createdAt', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    await expect(builder.build(defaultParams(wallet, { createdAt: 0 }))).rejects.toMatchObject({
      code: 'BUILDER_INVALID_CREATED_AT',
    });
  });

  test('throws BUILDER_INVALID_CREATED_AT for non-integer createdAt', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    await expect(
      builder.build(defaultParams(wallet, { createdAt: 1.5 })),
    ).rejects.toMatchObject({ code: 'BUILDER_INVALID_CREATED_AT' });
  });

  test('NonceManager called with DELIVERY_NONCE_KEY_SETUP', async () => {
    const nm = new TrackingNonceManager();
    const builder = new DeliverySetupBuilder(wallet, nm);
    await builder.build(defaultParams(wallet));
    expect(nm.calls.some((c) => c.key === DELIVERY_NONCE_KEY_SETUP)).toBe(true);
  });

  test('NonceManager getNextNonce called exactly once per build', async () => {
    const nm = new TrackingNonceManager();
    const builder = new DeliverySetupBuilder(wallet, nm);
    await builder.build(defaultParams(wallet));
    await builder.build(defaultParams(wallet, { createdAt: BASE_NOW + 1 }));
    const calls = nm.calls.filter(
      (c) => c.method === 'getNextNonce' && c.key === DELIVERY_NONCE_KEY_SETUP,
    );
    expect(calls).toHaveLength(2);
  });

  test('Missing NonceManager is tolerated (no throw)', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    await expect(builder.build(defaultParams(wallet))).resolves.toBeDefined();
  });

  test('Two builds produce different signatures (signed bytes differ at createdAt)', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    const { wire: a } = await builder.build(defaultParams(wallet, { createdAt: BASE_NOW }));
    const { wire: b } = await builder.build(defaultParams(wallet, { createdAt: BASE_NOW + 1 }));
    expect(a.requesterSig).not.toBe(b.requesterSig);
  });

  test('signature is exactly 132 chars (0x + 130 hex) — 65-byte EIP-712 sig', async () => {
    const { wire } = await new DeliverySetupBuilder(wallet).build(defaultParams(wallet));
    expect(wire.requesterSig).toHaveLength(132);
  });

  test('returned wire object has no extra top-level fields', async () => {
    const { wire } = await new DeliverySetupBuilder(wallet).build(defaultParams(wallet));
    expect(Object.keys(wire).sort()).toEqual(['requesterSig', 'signed']);
  });

  test('all 12 EIP-712 signed fields are present', async () => {
    const { wire } = await new DeliverySetupBuilder(wallet).build(defaultParams(wallet));
    // H4 fix (AIP-16 Phase 3): added smartWalletNonce → 12 fields.
    expect(Object.keys(wire.signed).sort()).toEqual(
      [
        'version',
        'txId',
        'chainId',
        'kernelAddress',
        'requesterAddress',
        'signerAddress',
        'buyerEphemeralPubkey',
        'acceptedChannels',
        'expectedPrivacy',
        'createdAt',
        'expiresAt',
        'smartWalletNonce',
      ].sort(),
    );
  });

  test('requesterAddress can differ from signerAddress (smart-wallet pattern)', async () => {
    const smartWallet = Wallet.createRandom();
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build(
      defaultParams(wallet, { requesterAddress: smartWallet.address as `0x${string}` }),
    );
    expect(wire.signed.requesterAddress.toLowerCase()).toBe(
      smartWallet.address.toLowerCase(),
    );
    expect(wire.signed.signerAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});

// ----------------------------------------------------------------------------
// verify()
// ----------------------------------------------------------------------------

describe('DeliverySetupBuilder.verify()', () => {
  let wallet: HDNodeWallet;
  let validWire: DeliverySetupWireV1;

  beforeEach(async () => {
    wallet = Wallet.createRandom();
    validWire = await buildValidWire(wallet);
  });

  afterEach(() => {
    resetSecondsNowForTests();
  });

  test('valid wire returns ok=true with signed payload', () => {
    const result = DeliverySetupBuilder.verify(validWire, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signed.txId).toBe(TX_ID);
    }
  });

  test('valid wire with expectedKernelAddress checksum-case still accepted', () => {
    const result = DeliverySetupBuilder.verify(validWire, {
      expectedKernelAddress: KERNEL_A.toLowerCase(),
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(true);
  });

  test('valid public-privacy wire verifies', async () => {
    const w = await buildValidWire(wallet, {
      expectedPrivacy: 'public',
      buyerEphemeralPubkey: CANONICAL_EMPTY_BYTES32,
    });
    const result = DeliverySetupBuilder.verify(w, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(true);
  });

  test('tampered signed.txId fails with setup_signature_invalid', () => {
    const tampered: DeliverySetupWireV1 = {
      ...validWire,
      signed: {
        ...validWire.signed,
        txId: ('0x' + 'ff'.repeat(32)) as `0x${string}`,
      },
    };
    const result = DeliverySetupBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_signature_invalid');
  });

  test('tampered requesterAddress fails (sig recovery differs)', () => {
    const other = Wallet.createRandom();
    const tampered: DeliverySetupWireV1 = {
      ...validWire,
      signed: {
        ...validWire.signed,
        requesterAddress: other.address as `0x${string}`,
      },
    };
    const result = DeliverySetupBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_signature_invalid');
  });

  test('tampered signerAddress fails (recovered EOA does not match signed.signerAddress)', () => {
    const other = Wallet.createRandom();
    const tampered: DeliverySetupWireV1 = {
      ...validWire,
      signed: {
        ...validWire.signed,
        signerAddress: other.address as `0x${string}`,
      },
    };
    const result = DeliverySetupBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_signature_invalid');
  });

  test('tampered buyerEphemeralPubkey fails (signature invalid)', () => {
    const tampered: DeliverySetupWireV1 = {
      ...validWire,
      signed: {
        ...validWire.signed,
        buyerEphemeralPubkey: ('0x' + 'ee'.repeat(32)) as `0x${string}`,
      },
    };
    const result = DeliverySetupBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_signature_invalid');
  });

  test('tampered acceptedChannels fails (signature invalid)', () => {
    const tampered: DeliverySetupWireV1 = {
      ...validWire,
      signed: {
        ...validWire.signed,
        acceptedChannels: ['malicious'],
      },
    };
    const result = DeliverySetupBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_signature_invalid');
  });

  test('wrong kernelAddress (allowlist mismatch) fails with setup_kernel_mismatch', () => {
    const result = DeliverySetupBuilder.verify(validWire, {
      expectedKernelAddress: KERNEL_B,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_kernel_mismatch');
  });

  test('wrong expectedChainId fails with setup_chain_mismatch', () => {
    const result = DeliverySetupBuilder.verify(validWire, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: 1,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_chain_mismatch');
  });

  test('createdAt skew > 900s in the past fails setup_timestamp_skew', () => {
    const result = DeliverySetupBuilder.verify(validWire, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW + SETUP_TIMESTAMP_SKEW_SEC + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_timestamp_skew');
  });

  test('createdAt skew > 900s in the future fails setup_timestamp_skew', () => {
    const result = DeliverySetupBuilder.verify(validWire, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW - SETUP_TIMESTAMP_SKEW_SEC - 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_timestamp_skew');
  });

  test('createdAt skew exactly at 900s boundary still passes', async () => {
    // Build a wire whose expiresAt is well beyond `now + skew` so we
    // only exercise the skew boundary, not the expiry check.
    const w = await buildValidWire(wallet, { expiresInSec: 7200 });
    const result = DeliverySetupBuilder.verify(w, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW + SETUP_TIMESTAMP_SKEW_SEC,
    });
    expect(result.ok).toBe(true);
  });

  test('expiresAt before now fails setup_expired', async () => {
    // Build a wire with createdAt within skew but expiresAt before "now".
    const w = await buildValidWire(wallet, {
      createdAt: BASE_NOW - 500,
      expiresInSec: 100, // expiresAt = BASE_NOW - 400
    });
    const result = DeliverySetupBuilder.verify(w, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_expired');
  });

  test('expiresAt exactly equal to now is treated as expired (strict >)', async () => {
    const w = await buildValidWire(wallet, {
      createdAt: BASE_NOW - 100,
      expiresInSec: 100, // expiresAt === BASE_NOW
    });
    const result = DeliverySetupBuilder.verify(w, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_expired');
  });

  test('invalid signature shape fails setup_signature_invalid', () => {
    const tampered: DeliverySetupWireV1 = {
      ...validWire,
      requesterSig: '0xdeadbeef' as `0x${string}`,
    };
    const result = DeliverySetupBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_signature_invalid');
  });

  test('flipping one byte in the signature fails setup_signature_invalid', () => {
    // Build a tampered sig by changing one hex char in the r component.
    const orig = validWire.requesterSig;
    const tamperedHex =
      orig.slice(0, 3) + (orig[3] === 'a' ? 'b' : 'a') + orig.slice(4);
    const tampered: DeliverySetupWireV1 = {
      ...validWire,
      requesterSig: tamperedHex as `0x${string}`,
    };
    const result = DeliverySetupBuilder.verify(tampered, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_signature_invalid');
  });

  test('malformed top-level wire (not an object) fails setup_signature_invalid', () => {
    const result = DeliverySetupBuilder.verify(null as unknown as DeliverySetupWireV1, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('setup_signature_invalid');
  });

  test('missing signed field fails setup_signature_invalid', () => {
    const broken = { requesterSig: validWire.requesterSig } as unknown as DeliverySetupWireV1;
    const result = DeliverySetupBuilder.verify(broken, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(false);
  });

  test('verify accepts a fresh wire when opts.now omitted (uses real clock)', async () => {
    // Build a wire with createdAt = real-now to avoid skew.
    const realNow = Math.floor(Date.now() / 1000);
    const w = await buildValidWire(wallet, { createdAt: realNow, expiresInSec: 3600 });
    const result = DeliverySetupBuilder.verify(w, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
    });
    expect(result.ok).toBe(true);
  });

  test('roundtrip: build then verify same wire is ok=true', async () => {
    const w = await buildValidWire(wallet, { createdAt: BASE_NOW });
    const result = DeliverySetupBuilder.verify(w, {
      expectedKernelAddress: KERNEL_A,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(true);
  });

  test('EIP-712 interop: signature verifies via raw ethers.verifyTypedData', async () => {
    const domain = buildDeliveryDomain(CHAIN_ID, KERNEL_A);
    const recovered = ethers.verifyTypedData(
      domain,
      DELIVERY_SETUP_TYPES_V1,
      validWire.signed as unknown as Record<string, unknown>,
      validWire.requesterSig,
    );
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});

// ----------------------------------------------------------------------------
// computeHash()
// ----------------------------------------------------------------------------

describe('DeliverySetupBuilder.computeHash()', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('same input produces same hash', async () => {
    const w1 = await buildValidWire(wallet);
    const h1 = DeliverySetupBuilder.computeHash(w1);
    const h2 = DeliverySetupBuilder.computeHash(w1);
    expect(h1).toBe(h2);
  });

  test('different signed.txId produces different hash', async () => {
    const w1 = await buildValidWire(wallet);
    const w2 = await buildValidWire(wallet, {
      txId: ('0x' + 'fe'.repeat(32)) as `0x${string}`,
    });
    const h1 = DeliverySetupBuilder.computeHash(w1);
    const h2 = DeliverySetupBuilder.computeHash(w2);
    expect(h1).not.toBe(h2);
  });

  test('different createdAt produces different hash', async () => {
    const w1 = await buildValidWire(wallet, { createdAt: BASE_NOW });
    const w2 = await buildValidWire(wallet, { createdAt: BASE_NOW + 1 });
    const h1 = DeliverySetupBuilder.computeHash(w1);
    const h2 = DeliverySetupBuilder.computeHash(w2);
    expect(h1).not.toBe(h2);
  });

  test('hash is independent of serverMeta decoration', async () => {
    const w = await buildValidWire(wallet);
    const h1 = DeliverySetupBuilder.computeHash(w);
    const wWithMeta: DeliverySetupWireV1 = {
      ...w,
      serverMeta: { receivedAt: '2026-06-01T00:00:00Z', relayId: 'relay-1' },
    };
    const h2 = DeliverySetupBuilder.computeHash(wWithMeta);
    expect(h1).toBe(h2);
  });

  test('hash is independent of requesterSig', async () => {
    const w = await buildValidWire(wallet);
    const h1 = DeliverySetupBuilder.computeHash(w);
    const mutated: DeliverySetupWireV1 = {
      ...w,
      requesterSig: ('0x' + 'aa'.repeat(65)) as `0x${string}`,
    };
    const h2 = DeliverySetupBuilder.computeHash(mutated);
    expect(h1).toBe(h2);
  });

  test('hash output format is 0x + 64 lowercase hex chars', async () => {
    const w = await buildValidWire(wallet);
    const h = DeliverySetupBuilder.computeHash(w);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
