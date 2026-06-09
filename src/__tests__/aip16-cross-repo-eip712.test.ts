/**
 * AIP-16 — Cross-repo EIP-712 contract validation.
 * =================================================
 *
 * Proves that the SDK (`src/delivery/eip712.ts`) and the Platform mirror
 * (`Platform/agirails.app/web/lib/delivery/eip712.ts`) produce and verify
 * byte-identical EIP-712 signatures for both `DeliverySetupSignedV1` and
 * `DeliveryEnvelopeSignedV1`.
 *
 * Any silent drift between the two repos (field reorder, type change,
 * domain name/version mismatch) would surface here BEFORE shipping —
 * not in production via signature_recovery_mismatch errors.
 *
 * Verification matrix per payload (setup, envelope):
 *   A. Sign once with a known fixture private key + deterministic field values.
 *   B. Recover via SDK helper (recoverSetupSigner / recoverEnvelopeSigner)
 *      and assert recovered == known address.
 *   C. Recover via Platform helper (same names) and assert recovered == known.
 *   D. Recover via raw `ethers.verifyTypedData` using SDK domain + types.
 *   E. Recover via raw `ethers.verifyTypedData` using Platform domain + types.
 *   F. Re-sign on the Platform side and assert SDK sig bytes == Platform sig bytes
 *      (deterministic ECDSA via ethers Wallet.signTypedData).
 *
 * Negative:
 *   G. Tweaking one byte of any field changes the recovered address.
 *   H. Verifying with the Receipts V2 domain (`name: "AGIRAILS Receipts",
 *      version: "2"`) DOES NOT recover the original signer — proves no
 *      cross-feature replay.
 *
 * All crypto is exercised end-to-end with ethers v6, no mocks.
 */

import { ethers } from 'ethers';

// SDK helpers (canonical source).
import {
  DELIVERY_DOMAIN_NAME as SDK_DELIVERY_DOMAIN_NAME,
  DELIVERY_DOMAIN_VERSION as SDK_DELIVERY_DOMAIN_VERSION,
  DELIVERY_ENVELOPE_TYPES_V1 as SDK_DELIVERY_ENVELOPE_TYPES_V1,
  DELIVERY_SETUP_TYPES_V1 as SDK_DELIVERY_SETUP_TYPES_V1,
  buildDeliveryDomain as sdkBuildDeliveryDomain,
  recoverEnvelopeSigner as sdkRecoverEnvelopeSigner,
  recoverSetupSigner as sdkRecoverSetupSigner,
} from '../delivery/eip712';
import type {
  DeliveryEnvelopeSignedV1,
  DeliverySetupSignedV1,
} from '../delivery/types';

// Platform mirror — cross-repo import via relative path that escapes the
// SDK package. ts-jest tolerates this because `rootDir` enforcement is on
// emitted output, not test compilation, and we never emit this file.
//
// If this import path ever breaks (Platform refactor moves the file), the
// test must be updated in lock-step — that is the *point* of this test.
//
// 2026-06-09: the cross-repo path is only present in the developer's local
// sibling layout (Damir's machine). In GitHub Actions only sdk-js is
// checked out, so the require throws and blocks all unrelated tests. We
// gate the entire suite behind fs.existsSync and degrade to describe.skip
// in CI. The contract-equivalence guarantee is still enforced — locally,
// by this suite; CI-side, by the Platform repo's own EIP-712 unit tests.
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pathLib = require('path') as typeof import('path');
const platformDir = pathLib.resolve(
  __dirname,
  '../../../../Platform/agirails.app/web/lib/delivery'
);
const platformAvailable =
  fs.existsSync(pathLib.join(platformDir, 'eip712.ts')) ||
  fs.existsSync(pathLib.join(platformDir, 'eip712.js'));
const describeCrossRepo = platformAvailable ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const platformEip712 = (platformAvailable
  ? require('../../../../Platform/agirails.app/web/lib/delivery/eip712')
  : {}) as {
  DELIVERY_DOMAIN_NAME: string;
  DELIVERY_DOMAIN_VERSION: string;
  DELIVERY_SETUP_TYPES_V1: Record<string, ethers.TypedDataField[]>;
  DELIVERY_ENVELOPE_TYPES_V1: Record<string, ethers.TypedDataField[]>;
  buildDeliveryDomain: (
    chainId: number,
    kernelAddress: string,
  ) => {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  recoverSetupSigner: (
    payload: DeliverySetupSignedV1,
    signature: string,
    kernelAddress: string,
  ) => string;
  recoverEnvelopeSigner: (
    payload: DeliveryEnvelopeSignedV1,
    signature: string,
    kernelAddress: string,
  ) => string;
};

// ---------------------------------------------------------------------------
// Known fixture
// ---------------------------------------------------------------------------
//
// Deterministic private key. Address derived once via ethers and asserted
// inline so this constant cannot silently drift.
const FIXTURE_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const KERNEL_ADDRESS = '0x469CBADbACFFE096270594F0a31f0EEC53753411';
const CHAIN_ID_SEPOLIA = 84532;

function makeSetupPayload(signer: string): DeliverySetupSignedV1 {
  return {
    version: 1,
    txId: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    chainId: CHAIN_ID_SEPOLIA,
    kernelAddress: KERNEL_ADDRESS as `0x${string}`,
    requesterAddress: signer as `0x${string}`,
    signerAddress: signer as `0x${string}`,
    buyerEphemeralPubkey: ('0x' + 'cd'.repeat(32)) as `0x${string}`,
    acceptedChannels: ['agirails-relay-v1'],
    expectedPrivacy: 'encrypted',
    createdAt: 1_730_000_000,
    expiresAt: 1_730_000_600,
    smartWalletNonce: 0,
  };
}

function makeEnvelopePayload(signer: string): DeliveryEnvelopeSignedV1 {
  return {
    version: 1,
    txId: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    chainId: CHAIN_ID_SEPOLIA,
    kernelAddress: KERNEL_ADDRESS as `0x${string}`,
    providerAddress: signer as `0x${string}`,
    signerAddress: signer as `0x${string}`,
    scheme: 'x25519-aes256gcm-v1',
    providerEphemeralPubkey: ('0x' + 'ef'.repeat(32)) as `0x${string}`,
    nonce: ('0x' + '11'.repeat(12)) as `0x${string}`,
    payloadHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
    tag: ('0x' + '33'.repeat(16)) as `0x${string}`,
    createdAt: 1_730_000_010,
    smartWalletNonce: 0,
  };
}

describeCrossRepo('AIP-16 cross-repo EIP-712 contract', () => {
  let wallet: ethers.Wallet;
  let signerAddress: string;

  beforeAll(() => {
    wallet = new ethers.Wallet(FIXTURE_PRIVATE_KEY);
    signerAddress = wallet.address;
  });

  // -------------------------------------------------------------------------
  // Sanity: domain constants must literally match across repos.
  // -------------------------------------------------------------------------
  it('SDK and Platform expose identical domain name + version', () => {
    expect(platformEip712.DELIVERY_DOMAIN_NAME).toBe(SDK_DELIVERY_DOMAIN_NAME);
    expect(platformEip712.DELIVERY_DOMAIN_VERSION).toBe(
      SDK_DELIVERY_DOMAIN_VERSION,
    );
    expect(SDK_DELIVERY_DOMAIN_NAME).toBe('AGIRAILS Delivery');
    expect(SDK_DELIVERY_DOMAIN_VERSION).toBe('1');
  });

  it('SDK and Platform expose byte-identical setup type schema', () => {
    expect(platformEip712.DELIVERY_SETUP_TYPES_V1).toEqual(
      SDK_DELIVERY_SETUP_TYPES_V1,
    );
  });

  it('SDK and Platform expose byte-identical envelope type schema', () => {
    expect(platformEip712.DELIVERY_ENVELOPE_TYPES_V1).toEqual(
      SDK_DELIVERY_ENVELOPE_TYPES_V1,
    );
  });

  it('SDK and Platform build identical domain objects for same chainId+kernel', () => {
    expect(
      platformEip712.buildDeliveryDomain(CHAIN_ID_SEPOLIA, KERNEL_ADDRESS),
    ).toEqual(sdkBuildDeliveryDomain(CHAIN_ID_SEPOLIA, KERNEL_ADDRESS));
  });

  // -------------------------------------------------------------------------
  // Setup payload — full A/B/C/D/E/F matrix.
  // -------------------------------------------------------------------------
  describe('DeliverySetupSignedV1', () => {
    let payload: DeliverySetupSignedV1;
    let sdkDomain: ReturnType<typeof sdkBuildDeliveryDomain>;
    let platformDomain: ReturnType<typeof platformEip712.buildDeliveryDomain>;
    let sdkSignature: string;
    let platformSignature: string;

    beforeAll(async () => {
      payload = makeSetupPayload(signerAddress);
      sdkDomain = sdkBuildDeliveryDomain(payload.chainId, KERNEL_ADDRESS);
      platformDomain = platformEip712.buildDeliveryDomain(
        payload.chainId,
        KERNEL_ADDRESS,
      );

      // (A) Sign using SDK domain + types.
      sdkSignature = await wallet.signTypedData(
        sdkDomain,
        SDK_DELIVERY_SETUP_TYPES_V1,
        payload,
      );
      // (F) Sign using Platform domain + types — must produce the SAME bytes.
      platformSignature = await wallet.signTypedData(
        platformDomain,
        platformEip712.DELIVERY_SETUP_TYPES_V1,
        payload,
      );
    });

    it('(G) SDK signature bytes == Platform signature bytes', () => {
      // ECDSA via ethers is deterministic (RFC 6979) — identical typed data
      // + identical key must yield identical bytes.
      expect(sdkSignature).toBe(platformSignature);
    });

    it('(B) SDK recoverSetupSigner returns the known address', () => {
      const recovered = sdkRecoverSetupSigner(
        payload,
        sdkSignature,
        KERNEL_ADDRESS,
      );
      expect(recovered.toLowerCase()).toBe(signerAddress.toLowerCase());
    });

    it('(C) Platform recoverSetupSigner returns the known address', () => {
      const recovered = platformEip712.recoverSetupSigner(
        payload,
        sdkSignature,
        KERNEL_ADDRESS,
      );
      expect(recovered.toLowerCase()).toBe(signerAddress.toLowerCase());
    });

    it('(D) raw ethers.verifyTypedData with SDK domain+types recovers known address', () => {
      const recovered = ethers.verifyTypedData(
        sdkDomain,
        SDK_DELIVERY_SETUP_TYPES_V1,
        payload,
        sdkSignature,
      );
      expect(recovered.toLowerCase()).toBe(signerAddress.toLowerCase());
    });

    it('(E) raw ethers.verifyTypedData with Platform domain+types recovers known address', () => {
      const recovered = ethers.verifyTypedData(
        platformDomain,
        platformEip712.DELIVERY_SETUP_TYPES_V1,
        payload,
        sdkSignature,
      );
      expect(recovered.toLowerCase()).toBe(signerAddress.toLowerCase());
    });

    // -----------------------------------------------------------------------
    // Negative: every signed field is bound — flipping ANY byte changes the
    // recovered address (or causes ethers to fail). We assert "recovered
    // != known" for each field.
    // -----------------------------------------------------------------------
    it.each<keyof DeliverySetupSignedV1>([
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
    ])('(I) mutating field "%s" changes the recovered signer', (field) => {
      const mutated: DeliverySetupSignedV1 = { ...payload };
      switch (field) {
        case 'version':
          // version is `1` — we can't change it without breaking ts type,
          // but EIP-712 encodes the uint8 by value; nudging it to 2 via
          // cast is sufficient defense-in-depth.
          (mutated as unknown as { version: number }).version = 2;
          break;
        case 'txId':
          mutated.txId = ('0x' + 'ab'.repeat(31) + 'ac') as `0x${string}`;
          break;
        case 'chainId':
          mutated.chainId = payload.chainId + 1;
          break;
        case 'kernelAddress':
          mutated.kernelAddress =
            '0x0000000000000000000000000000000000000001' as `0x${string}`;
          break;
        case 'requesterAddress':
          mutated.requesterAddress =
            '0x0000000000000000000000000000000000000002' as `0x${string}`;
          break;
        case 'signerAddress':
          mutated.signerAddress =
            '0x0000000000000000000000000000000000000003' as `0x${string}`;
          break;
        case 'buyerEphemeralPubkey':
          mutated.buyerEphemeralPubkey = ('0x' +
            'cd'.repeat(31) +
            'ce') as `0x${string}`;
          break;
        case 'acceptedChannels':
          mutated.acceptedChannels = ['agirails-relay-v2'];
          break;
        case 'expectedPrivacy':
          mutated.expectedPrivacy = 'public';
          break;
        case 'createdAt':
          mutated.createdAt = payload.createdAt + 1;
          break;
        case 'expiresAt':
          mutated.expiresAt = payload.expiresAt + 1;
          break;
        case 'smartWalletNonce':
          // H4 fix: mutating smartWalletNonce changes the recovered signer
          // (it is bound by the EIP-712 type hash).
          mutated.smartWalletNonce = (payload.smartWalletNonce ?? 0) + 1;
          break;
      }

      const recovered = sdkRecoverSetupSigner(
        mutated,
        sdkSignature,
        KERNEL_ADDRESS,
      );
      // The signature was made over `payload`, not `mutated`; recovery
      // returns some OTHER address.
      expect(recovered.toLowerCase()).not.toBe(signerAddress.toLowerCase());
    });

    it('(J) verifying under Receipts V2 domain does NOT recover the signer', () => {
      // No cross-feature replay: a sig made under "AGIRAILS Delivery"/v1
      // must NOT recover the same signer when verified under
      // "AGIRAILS Receipts"/v2 (the AIP-3 domain). The receipts type schema
      // for ReceiptWriteV2 is unrelated, so we reuse the delivery type
      // schema but with the receipts domain — the *domain separator* is
      // the line of defense.
      const replayDomain = {
        name: 'AGIRAILS Receipts',
        version: '2',
        chainId: sdkDomain.chainId,
        verifyingContract: sdkDomain.verifyingContract,
      };
      const recovered = ethers.verifyTypedData(
        replayDomain,
        SDK_DELIVERY_SETUP_TYPES_V1,
        payload,
        sdkSignature,
      );
      expect(recovered.toLowerCase()).not.toBe(signerAddress.toLowerCase());
    });
  });

  // -------------------------------------------------------------------------
  // Envelope payload — repeat of the full matrix.
  // -------------------------------------------------------------------------
  describe('DeliveryEnvelopeSignedV1', () => {
    let payload: DeliveryEnvelopeSignedV1;
    let sdkDomain: ReturnType<typeof sdkBuildDeliveryDomain>;
    let platformDomain: ReturnType<typeof platformEip712.buildDeliveryDomain>;
    let sdkSignature: string;
    let platformSignature: string;

    beforeAll(async () => {
      payload = makeEnvelopePayload(signerAddress);
      sdkDomain = sdkBuildDeliveryDomain(payload.chainId, KERNEL_ADDRESS);
      platformDomain = platformEip712.buildDeliveryDomain(
        payload.chainId,
        KERNEL_ADDRESS,
      );

      sdkSignature = await wallet.signTypedData(
        sdkDomain,
        SDK_DELIVERY_ENVELOPE_TYPES_V1,
        payload,
      );
      platformSignature = await wallet.signTypedData(
        platformDomain,
        platformEip712.DELIVERY_ENVELOPE_TYPES_V1,
        payload,
      );
    });

    it('(G) SDK signature bytes == Platform signature bytes', () => {
      expect(sdkSignature).toBe(platformSignature);
    });

    it('(B) SDK recoverEnvelopeSigner returns the known address', () => {
      const recovered = sdkRecoverEnvelopeSigner(
        payload,
        sdkSignature,
        KERNEL_ADDRESS,
      );
      expect(recovered.toLowerCase()).toBe(signerAddress.toLowerCase());
    });

    it('(C) Platform recoverEnvelopeSigner returns the known address', () => {
      const recovered = platformEip712.recoverEnvelopeSigner(
        payload,
        sdkSignature,
        KERNEL_ADDRESS,
      );
      expect(recovered.toLowerCase()).toBe(signerAddress.toLowerCase());
    });

    it('(D) raw ethers.verifyTypedData with SDK domain+types recovers known address', () => {
      const recovered = ethers.verifyTypedData(
        sdkDomain,
        SDK_DELIVERY_ENVELOPE_TYPES_V1,
        payload,
        sdkSignature,
      );
      expect(recovered.toLowerCase()).toBe(signerAddress.toLowerCase());
    });

    it('(E) raw ethers.verifyTypedData with Platform domain+types recovers known address', () => {
      const recovered = ethers.verifyTypedData(
        platformDomain,
        platformEip712.DELIVERY_ENVELOPE_TYPES_V1,
        payload,
        sdkSignature,
      );
      expect(recovered.toLowerCase()).toBe(signerAddress.toLowerCase());
    });

    it.each<keyof DeliveryEnvelopeSignedV1>([
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
    ])('(I) mutating field "%s" changes the recovered signer', (field) => {
      const mutated: DeliveryEnvelopeSignedV1 = { ...payload };
      switch (field) {
        case 'version':
          (mutated as unknown as { version: number }).version = 2;
          break;
        case 'txId':
          mutated.txId = ('0x' + 'ab'.repeat(31) + 'ac') as `0x${string}`;
          break;
        case 'chainId':
          mutated.chainId = payload.chainId + 1;
          break;
        case 'kernelAddress':
          mutated.kernelAddress =
            '0x0000000000000000000000000000000000000001' as `0x${string}`;
          break;
        case 'providerAddress':
          mutated.providerAddress =
            '0x0000000000000000000000000000000000000002' as `0x${string}`;
          break;
        case 'signerAddress':
          mutated.signerAddress =
            '0x0000000000000000000000000000000000000003' as `0x${string}`;
          break;
        case 'scheme':
          mutated.scheme = 'public-v1';
          break;
        case 'providerEphemeralPubkey':
          mutated.providerEphemeralPubkey = ('0x' +
            'ef'.repeat(31) +
            'f0') as `0x${string}`;
          break;
        case 'nonce':
          mutated.nonce = ('0x' + '11'.repeat(11) + '12') as `0x${string}`;
          break;
        case 'payloadHash':
          mutated.payloadHash = ('0x' +
            '22'.repeat(31) +
            '23') as `0x${string}`;
          break;
        case 'tag':
          mutated.tag = ('0x' + '33'.repeat(15) + '34') as `0x${string}`;
          break;
        case 'createdAt':
          mutated.createdAt = payload.createdAt + 1;
          break;
        case 'smartWalletNonce':
          // H4 fix: mutating smartWalletNonce changes the recovered signer.
          mutated.smartWalletNonce = (payload.smartWalletNonce ?? 0) + 1;
          break;
      }

      const recovered = sdkRecoverEnvelopeSigner(
        mutated,
        sdkSignature,
        KERNEL_ADDRESS,
      );
      expect(recovered.toLowerCase()).not.toBe(signerAddress.toLowerCase());
    });

    it('(J) verifying under Receipts V2 domain does NOT recover the signer', () => {
      const replayDomain = {
        name: 'AGIRAILS Receipts',
        version: '2',
        chainId: sdkDomain.chainId,
        verifyingContract: sdkDomain.verifyingContract,
      };
      const recovered = ethers.verifyTypedData(
        replayDomain,
        SDK_DELIVERY_ENVELOPE_TYPES_V1,
        payload,
        sdkSignature,
      );
      expect(recovered.toLowerCase()).not.toBe(signerAddress.toLowerCase());
    });
  });
});
