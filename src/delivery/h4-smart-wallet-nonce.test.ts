/**
 * AIP-16 Phase 3 H4 fix — Smart-wallet factory-nonce flexibility.
 * ================================================================
 *
 * Phase 3 HIGH finding H4:
 *   The Platform's `computeSmartWalletFromSigner` hardcoded the
 *   CoinbaseSmartWallet factory nonce to `0`. Legitimate users whose
 *   Smart Wallet was deployed at nonce>=1 (e.g. recreated wallets,
 *   advanced operational patterns) were permanently locked out of the
 *   delivery surface with `signer_role_mismatch` — even though their
 *   on-chain wallet existed and they correctly signed payloads.
 *
 * Remediation (Option A):
 *   - Append a new `smartWalletNonce: uint256` field to BOTH
 *     `DELIVERY_SETUP_TYPES_V1` and `DELIVERY_ENVELOPE_TYPES_V1` at
 *     the END of the field list, preserving positional encoding
 *     stability for existing toolchains.
 *   - SDK builders accept an optional `smartWalletNonce` parameter
 *     (default `0`), so pre-H4 callers continue to produce the same
 *     on-wire signatures as before.
 *   - Verifier (`recoverSetupSigner` / `recoverEnvelopeSigner`)
 *     normalizes a payload with undefined `smartWalletNonce` to `0`
 *     before handing it to `ethers.verifyTypedData`, so wire payloads
 *     from pre-H4 SDKs continue to verify against the new schema.
 *
 * This test file covers:
 *   1. Builder with default nonce=0 produces the same projection as
 *      explicit nonce=0.
 *   2. Builder with nonce=5 signs and the projection reflects it.
 *   3. Roundtrip recovery with non-zero nonce returns the real signer.
 *   4. Cross-repo type-schema parity holds after the field addition
 *      (smoke-checking the existing aip16-cross-repo-eip712 invariant
 *      from this file's perspective).
 *   5. Invalid `smartWalletNonce` (negative / non-integer) is rejected
 *      with `BUILDER_INVALID_SMART_WALLET_NONCE` — defense in depth so
 *      callers see a clear typed error instead of an opaque ethers
 *      ABI-encoding failure deep in the signing path.
 *   6. A signature made with nonce=5 does NOT verify under nonce=0
 *      (the field is bound by the EIP-712 type hash).
 */

import { ethers, Wallet, type HDNodeWallet } from 'ethers';

import {
  DELIVERY_ENVELOPE_TYPES_V1,
  DELIVERY_SETUP_TYPES_V1,
  DeliveryEip712Error,
  buildDeliveryDomain,
  recoverEnvelopeSigner,
  recoverSetupSigner,
} from './eip712';
import { DeliveryEnvelopeBuilder } from './envelopeBuilder';
import { DeliverySetupBuilder, type BuildSetupParams } from './setupBuilder';
import {
  CANONICAL_EMPTY_BYTES32,
  type DeliveryEnvelopeSignedV1,
  type DeliverySetupSignedV1,
} from './types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KERNEL = '0x469CBADbACFFE096270594F0a31f0EEC53753411' as `0x${string}`;
const SEPOLIA = 84532;
const TXID = ('0x' + '11'.repeat(32)) as `0x${string}`;
const PUBKEY = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const NOW = 1_750_000_000;

function setupParamsFor(
  wallet: HDNodeWallet,
  overrides: Partial<BuildSetupParams> = {},
): BuildSetupParams {
  return {
    txId: TXID,
    chainId: SEPOLIA,
    kernelAddress: KERNEL,
    requesterAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    buyerEphemeralPubkey: PUBKEY,
    expectedPrivacy: 'encrypted',
    createdAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup builder
// ---------------------------------------------------------------------------

describe('H4 — DeliverySetupBuilder.build with smartWalletNonce', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  it('defaults smartWalletNonce to 0 when omitted (backward-compat)', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build(setupParamsFor(wallet));
    expect(wire.signed.smartWalletNonce).toBe(0);
  });

  it('emits smartWalletNonce=5 in the signed projection when requested', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build(
      setupParamsFor(wallet, { smartWalletNonce: 5 }),
    );
    expect(wire.signed.smartWalletNonce).toBe(5);
  });

  it('verifier recovers the real signer with smartWalletNonce=5', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build(
      setupParamsFor(wallet, { smartWalletNonce: 5 }),
    );
    const recovered = recoverSetupSigner(wire.signed, wire.requesterSig, KERNEL);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('rejects negative smartWalletNonce with BUILDER_INVALID_SMART_WALLET_NONCE', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    await expect(
      builder.build(setupParamsFor(wallet, { smartWalletNonce: -1 })),
    ).rejects.toMatchObject({
      name: 'DeliveryEip712Error',
      code: 'BUILDER_INVALID_SMART_WALLET_NONCE',
    });
  });

  it('rejects non-integer smartWalletNonce with BUILDER_INVALID_SMART_WALLET_NONCE', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    await expect(
      builder.build(setupParamsFor(wallet, { smartWalletNonce: 1.5 })),
    ).rejects.toBeInstanceOf(DeliveryEip712Error);
  });

  it('signature made with nonce=5 does NOT verify when payload claims nonce=0 (field is bound)', async () => {
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build(
      setupParamsFor(wallet, { smartWalletNonce: 5 }),
    );
    const tampered: DeliverySetupSignedV1 = {
      ...wire.signed,
      smartWalletNonce: 0,
    };
    const recovered = recoverSetupSigner(tampered, wire.requesterSig, KERNEL);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('omitting smartWalletNonce on a verifier-side payload normalizes to 0', async () => {
    // A pre-H4 client that emits a payload without `smartWalletNonce` (the
    // field is optional on the TS interface for backwards compatibility)
    // must still verify against the new schema, because the verifier
    // normalizes undefined → 0 before handing the typed-data to ethers.
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build(setupParamsFor(wallet)); // nonce defaults to 0
    // Simulate a pre-H4 payload by deleting the field after signing.
    const preH4: DeliverySetupSignedV1 = { ...wire.signed };
    delete (preH4 as { smartWalletNonce?: number }).smartWalletNonce;
    const recovered = recoverSetupSigner(preH4, wire.requesterSig, KERNEL);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// Envelope builder
// ---------------------------------------------------------------------------

describe('H4 — DeliveryEnvelopeBuilder.buildPublic with smartWalletNonce', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  function envParams(overrides: { smartWalletNonce?: number } = {}) {
    return {
      txId: TXID,
      chainId: SEPOLIA,
      kernelAddress: KERNEL,
      providerAddress: wallet.address as `0x${string}`,
      signerAddress: wallet.address as `0x${string}`,
      payload: { hello: 'world' },
      createdAt: NOW,
      ...overrides,
    };
  }

  it('defaults smartWalletNonce to 0 when omitted', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(envParams());
    expect(wire.signed.smartWalletNonce).toBe(0);
  });

  it('emits smartWalletNonce=3 in the signed projection when requested', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(envParams({ smartWalletNonce: 3 }));
    expect(wire.signed.smartWalletNonce).toBe(3);
  });

  it('verifier recovers the real signer with smartWalletNonce=3', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(envParams({ smartWalletNonce: 3 }));
    const recovered = recoverEnvelopeSigner(
      wire.signed,
      wire.providerSig,
      KERNEL,
    );
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('rejects negative smartWalletNonce with BUILDER_INVALID_SMART_WALLET_NONCE', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    await expect(
      builder.buildPublic(envParams({ smartWalletNonce: -2 })),
    ).rejects.toMatchObject({
      name: 'DeliveryEip712Error',
      code: 'BUILDER_INVALID_SMART_WALLET_NONCE',
    });
  });

  it('signature made with nonce=3 does NOT verify when payload claims nonce=0', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(envParams({ smartWalletNonce: 3 }));
    const tampered: DeliveryEnvelopeSignedV1 = {
      ...wire.signed,
      smartWalletNonce: 0,
    };
    const recovered = recoverEnvelopeSigner(
      tampered,
      wire.providerSig,
      KERNEL,
    );
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('omitting smartWalletNonce on a verifier-side payload normalizes to 0', async () => {
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic(envParams()); // nonce defaults to 0
    const preH4: DeliveryEnvelopeSignedV1 = { ...wire.signed };
    delete (preH4 as { smartWalletNonce?: number }).smartWalletNonce;
    const recovered = recoverEnvelopeSigner(preH4, wire.providerSig, KERNEL);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// Cross-repo schema parity (smoke)
// ---------------------------------------------------------------------------

describe('H4 — cross-repo type schema still byte-identical after smartWalletNonce addition', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const platformEip712 = require('../../../../Platform/agirails.app/web/lib/delivery/eip712') as {
    DELIVERY_SETUP_TYPES_V1: typeof DELIVERY_SETUP_TYPES_V1;
    DELIVERY_ENVELOPE_TYPES_V1: typeof DELIVERY_ENVELOPE_TYPES_V1;
  };

  it('setup type schema matches between SDK and Platform mirrors', () => {
    expect(platformEip712.DELIVERY_SETUP_TYPES_V1).toEqual(
      DELIVERY_SETUP_TYPES_V1,
    );
    // And smartWalletNonce is exactly at the END (positional stability
    // for older field indices).
    const fields = platformEip712.DELIVERY_SETUP_TYPES_V1.DeliverySetupSignedV1;
    expect(fields[fields.length - 1]).toEqual({
      name: 'smartWalletNonce',
      type: 'uint256',
    });
  });

  it('envelope type schema matches between SDK and Platform mirrors', () => {
    expect(platformEip712.DELIVERY_ENVELOPE_TYPES_V1).toEqual(
      DELIVERY_ENVELOPE_TYPES_V1,
    );
    const fields =
      platformEip712.DELIVERY_ENVELOPE_TYPES_V1.DeliveryEnvelopeSignedV1;
    expect(fields[fields.length - 1]).toEqual({
      name: 'smartWalletNonce',
      type: 'uint256',
    });
  });

  it('cross-repo recovery: SDK-signed payload with nonce=7 recovers via Platform helper', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recoverSetupSigner: platformRecover } = require('../../../../Platform/agirails.app/web/lib/delivery/eip712') as {
      recoverSetupSigner: typeof recoverSetupSigner;
    };
    const wallet = Wallet.createRandom();
    const builder = new DeliverySetupBuilder(wallet);
    const { wire } = await builder.build(
      setupParamsFor(wallet, { smartWalletNonce: 7 }),
    );
    const recovered = platformRecover(wire.signed, wire.requesterSig, KERNEL);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// Direct ethers.signTypedData / verifyTypedData roundtrip
// ---------------------------------------------------------------------------

describe('H4 — raw ethers roundtrip with smartWalletNonce', () => {
  it('signs and recovers a setup payload with smartWalletNonce=42 using only ethers', async () => {
    const wallet = Wallet.createRandom();
    const payload: DeliverySetupSignedV1 = {
      version: 1,
      txId: TXID,
      chainId: SEPOLIA,
      kernelAddress: KERNEL,
      requesterAddress: wallet.address as `0x${string}`,
      signerAddress: wallet.address as `0x${string}`,
      buyerEphemeralPubkey: PUBKEY,
      acceptedChannels: ['agirails-relay-v1'],
      expectedPrivacy: 'encrypted',
      createdAt: NOW,
      expiresAt: NOW + 600,
      smartWalletNonce: 42,
    };
    const domain = buildDeliveryDomain(SEPOLIA, KERNEL);
    const sig = await wallet.signTypedData(
      domain,
      DELIVERY_SETUP_TYPES_V1,
      payload,
    );
    const recovered = ethers.verifyTypedData(
      domain,
      DELIVERY_SETUP_TYPES_V1,
      payload,
      sig,
    );
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());

    // Sanity: changing nonce changes the recovered address (field is bound).
    const tampered = { ...payload, smartWalletNonce: 43 };
    const tamperedRecover = ethers.verifyTypedData(
      domain,
      DELIVERY_SETUP_TYPES_V1,
      tampered,
      sig,
    );
    expect(tamperedRecover.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });
});

// Suppress unused-import lint when test bodies branch on these symbols.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _used = CANONICAL_EMPTY_BYTES32;
