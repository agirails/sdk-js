/**
 * AIP-16 Delivery Surface — EIP-712 module unit tests.
 *
 * Covers:
 *  - Domain object shape (4 required fields, exact values).
 *  - Snapshot of the typed-data schemas — any reorder/rename is a HARD
 *    breaking change and must be caught by tests, not at runtime by a
 *    cross-SDK signature mismatch.
 *  - chainIdForNetwork mapping (testnet, mainnet, mock-throws,
 *    unknown-network-throws).
 *  - Domain builder defensive validation (chainId / kernelAddress).
 *  - Signature recovery roundtrip with a real ethers Wallet for both
 *    setup and envelope payloads.
 *  - Field-mutation defense: changing ANY field in the signed payload
 *    must change the recovered address (every field is bound by the
 *    EIP-712 type hash).
 *  - Domain separation from the receipts feature — a signature produced
 *    under the receipts domain MUST NOT recover the same signer when
 *    verified under the delivery domain.
 *
 * Crypto is exercised end-to-end with real ethers v6 — no mocks.
 */

import { ethers } from 'ethers';

import {
  DELIVERY_DOMAIN_NAME,
  DELIVERY_DOMAIN_VERSION,
  DELIVERY_ENVELOPE_TYPES_V1,
  DELIVERY_SETUP_TYPES_V1,
  DeliveryEip712Error,
  buildDeliveryDomain,
  chainIdForNetwork,
  recoverEnvelopeSigner,
  recoverSetupSigner,
} from './eip712';
import {
  CANONICAL_EMPTY_BYTES12,
  CANONICAL_EMPTY_BYTES16,
  CANONICAL_EMPTY_BYTES32,
  type DeliveryEnvelopeSignedV1,
  type DeliverySetupSignedV1,
} from './types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const KERNEL_ADDRESS = '0x469CBADbACFFE096270594F0a31f0EEC53753411';
const CHAIN_ID_SEPOLIA = 84532;

/** Build a valid setup payload signed by `wallet`. */
function buildSetupPayload(wallet: ethers.Wallet): DeliverySetupSignedV1 {
  return {
    version: 1,
    txId: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    chainId: CHAIN_ID_SEPOLIA,
    kernelAddress: KERNEL_ADDRESS as `0x${string}`,
    requesterAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    buyerEphemeralPubkey: ('0x' + 'cd'.repeat(32)) as `0x${string}`,
    acceptedChannels: ['agirails-relay-v1'],
    expectedPrivacy: 'encrypted',
    createdAt: 1_730_000_000,
    expiresAt: 1_730_000_600,
    smartWalletNonce: 0,
  };
}

function buildEnvelopePayload(wallet: ethers.Wallet): DeliveryEnvelopeSignedV1 {
  return {
    version: 1,
    txId: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    chainId: CHAIN_ID_SEPOLIA,
    kernelAddress: KERNEL_ADDRESS as `0x${string}`,
    providerAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    scheme: 'x25519-aes256gcm-v1',
    providerEphemeralPubkey: ('0x' + 'ef'.repeat(32)) as `0x${string}`,
    nonce: ('0x' + '11'.repeat(12)) as `0x${string}`,
    payloadHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
    tag: ('0x' + '33'.repeat(16)) as `0x${string}`,
    createdAt: 1_730_000_100,
    smartWalletNonce: 0,
  };
}

async function signSetup(
  wallet: ethers.Wallet,
  payload: DeliverySetupSignedV1,
  kernel: string = KERNEL_ADDRESS,
): Promise<string> {
  const domain = buildDeliveryDomain(payload.chainId, kernel);
  return wallet.signTypedData(domain, DELIVERY_SETUP_TYPES_V1, payload);
}

async function signEnvelope(
  wallet: ethers.Wallet,
  payload: DeliveryEnvelopeSignedV1,
  kernel: string = KERNEL_ADDRESS,
): Promise<string> {
  const domain = buildDeliveryDomain(payload.chainId, kernel);
  return wallet.signTypedData(domain, DELIVERY_ENVELOPE_TYPES_V1, payload);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('delivery/eip712 — domain constants', () => {
  it('exports the canonical delivery domain name', () => {
    expect(DELIVERY_DOMAIN_NAME).toBe('AGIRAILS Delivery');
  });

  it('exports the v1 domain version literal', () => {
    expect(DELIVERY_DOMAIN_VERSION).toBe('1');
  });

  it('domain name is distinct from receipts / negotiation', () => {
    // Cross-feature domain separation invariant.
    expect(DELIVERY_DOMAIN_NAME).not.toBe('AGIRAILS');
    expect(DELIVERY_DOMAIN_NAME).not.toBe('AGIRAILS Receipts');
  });
});

describe('delivery/eip712 — typed-data schemas (IMMUTABILITY snapshot)', () => {
  it('DELIVERY_SETUP_TYPES_V1 has the exact field order and types', () => {
    expect(DELIVERY_SETUP_TYPES_V1).toEqual({
      DeliverySetupSignedV1: [
        { name: 'version', type: 'uint8' },
        { name: 'txId', type: 'bytes32' },
        { name: 'chainId', type: 'uint256' },
        { name: 'kernelAddress', type: 'address' },
        { name: 'requesterAddress', type: 'address' },
        { name: 'signerAddress', type: 'address' },
        { name: 'buyerEphemeralPubkey', type: 'bytes32' },
        { name: 'acceptedChannels', type: 'string[]' },
        { name: 'expectedPrivacy', type: 'string' },
        { name: 'createdAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
        // H4 fix (AIP-16 Phase 3): appended at END of field list.
        { name: 'smartWalletNonce', type: 'uint256' },
      ],
    });
  });

  it('DELIVERY_SETUP_TYPES_V1 has exactly 12 fields', () => {
    // H4 fix: was 11, appended smartWalletNonce → 12.
    expect(DELIVERY_SETUP_TYPES_V1.DeliverySetupSignedV1).toHaveLength(12);
  });

  it('DELIVERY_ENVELOPE_TYPES_V1 has the exact field order and types', () => {
    expect(DELIVERY_ENVELOPE_TYPES_V1).toEqual({
      DeliveryEnvelopeSignedV1: [
        { name: 'version', type: 'uint8' },
        { name: 'txId', type: 'bytes32' },
        { name: 'chainId', type: 'uint256' },
        { name: 'kernelAddress', type: 'address' },
        { name: 'providerAddress', type: 'address' },
        { name: 'signerAddress', type: 'address' },
        { name: 'scheme', type: 'string' },
        { name: 'providerEphemeralPubkey', type: 'bytes32' },
        { name: 'nonce', type: 'bytes12' },
        { name: 'payloadHash', type: 'bytes32' },
        { name: 'tag', type: 'bytes16' },
        { name: 'createdAt', type: 'uint64' },
        // H4 fix (AIP-16 Phase 3): appended at END of field list.
        { name: 'smartWalletNonce', type: 'uint256' },
      ],
    });
  });

  it('DELIVERY_ENVELOPE_TYPES_V1 has exactly 13 fields', () => {
    // H4 fix: was 12, appended smartWalletNonce → 13.
    expect(DELIVERY_ENVELOPE_TYPES_V1.DeliveryEnvelopeSignedV1).toHaveLength(13);
  });
});

describe('delivery/eip712 — chainIdForNetwork', () => {
  it('returns 84532 for base-sepolia', () => {
    expect(chainIdForNetwork('base-sepolia')).toBe(84532);
  });

  it('returns 8453 for base-mainnet', () => {
    expect(chainIdForNetwork('base-mainnet')).toBe(8453);
  });

  it('throws DeliveryEip712Error with code MOCK_NETWORK_NOT_SUPPORTED on "mock"', () => {
    try {
      chainIdForNetwork('mock');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryEip712Error);
      expect((err as DeliveryEip712Error).code).toBe('MOCK_NETWORK_NOT_SUPPORTED');
    }
  });

  it('throws DeliveryEip712Error with code UNKNOWN_NETWORK on an unrecognized value', () => {
    try {
      // Forced cast — runtime path must still reject this.
      chainIdForNetwork('mars-l99' as unknown as 'base-sepolia');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryEip712Error);
      expect((err as DeliveryEip712Error).code).toBe('UNKNOWN_NETWORK');
    }
  });
});

describe('delivery/eip712 — buildDeliveryDomain', () => {
  it('returns the expected 4-field object given valid inputs', () => {
    const domain = buildDeliveryDomain(CHAIN_ID_SEPOLIA, KERNEL_ADDRESS);
    expect(domain).toEqual({
      name: 'AGIRAILS Delivery',
      version: '1',
      chainId: CHAIN_ID_SEPOLIA,
      verifyingContract: KERNEL_ADDRESS,
    });
  });

  it('returned object has exactly 4 keys (name, version, chainId, verifyingContract)', () => {
    const domain = buildDeliveryDomain(CHAIN_ID_SEPOLIA, KERNEL_ADDRESS);
    expect(Object.keys(domain).sort()).toEqual(
      ['chainId', 'name', 'verifyingContract', 'version'].sort(),
    );
  });

  it('throws INVALID_CHAIN_ID for non-positive chainId', () => {
    expect(() => buildDeliveryDomain(0, KERNEL_ADDRESS)).toThrow(DeliveryEip712Error);
    try {
      buildDeliveryDomain(-1, KERNEL_ADDRESS);
    } catch (err) {
      expect((err as DeliveryEip712Error).code).toBe('INVALID_CHAIN_ID');
    }
  });

  it('throws INVALID_CHAIN_ID for non-integer chainId', () => {
    try {
      buildDeliveryDomain(1.5, KERNEL_ADDRESS);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryEip712Error).code).toBe('INVALID_CHAIN_ID');
    }
  });

  it('throws INVALID_KERNEL_ADDRESS for malformed kernel', () => {
    try {
      buildDeliveryDomain(CHAIN_ID_SEPOLIA, '0xnot-an-address');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryEip712Error).code).toBe('INVALID_KERNEL_ADDRESS');
    }
  });

  it('throws INVALID_KERNEL_ADDRESS for empty string kernel', () => {
    try {
      buildDeliveryDomain(CHAIN_ID_SEPOLIA, '');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryEip712Error).code).toBe('INVALID_KERNEL_ADDRESS');
    }
  });
});

describe('delivery/eip712 — recoverSetupSigner', () => {
  it('recovers the signer of a setup payload to the expected EOA', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);
    const sig = await signSetup(wallet as unknown as ethers.Wallet, payload);
    const recovered = recoverSetupSigner(payload, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('mutating txId changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);
    const sig = await signSetup(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliverySetupSignedV1 = {
      ...payload,
      txId: ('0x' + 'ff'.repeat(32)) as `0x${string}`,
    };
    const recovered = recoverSetupSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('mutating chainId changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);
    const sig = await signSetup(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliverySetupSignedV1 = { ...payload, chainId: 8453 };
    // chainId change ALSO breaks the domain — but recovery still produces *some*
    // address that is not the original signer.
    const recovered = recoverSetupSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('mutating expectedPrivacy changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);
    const sig = await signSetup(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliverySetupSignedV1 = { ...payload, expectedPrivacy: 'public' };
    const recovered = recoverSetupSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('mutating createdAt changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);
    const sig = await signSetup(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliverySetupSignedV1 = { ...payload, createdAt: payload.createdAt + 1 };
    const recovered = recoverSetupSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('mutating buyerEphemeralPubkey changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);
    const sig = await signSetup(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliverySetupSignedV1 = {
      ...payload,
      buyerEphemeralPubkey: ('0x' + '00'.repeat(32)) as `0x${string}`,
    };
    const recovered = recoverSetupSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('mutating acceptedChannels changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);
    const sig = await signSetup(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliverySetupSignedV1 = {
      ...payload,
      acceptedChannels: ['other-relay-v1'],
    };
    const recovered = recoverSetupSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('throws INVALID_SIGNATURE for empty signature', () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);
    try {
      recoverSetupSigner(payload, '', KERNEL_ADDRESS);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryEip712Error);
      expect((err as DeliveryEip712Error).code).toBe('INVALID_SIGNATURE');
    }
  });

  it('throws INVALID_SIGNATURE for a malformed hex string', () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);
    try {
      recoverSetupSigner(payload, '0xnothex', KERNEL_ADDRESS);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryEip712Error).code).toBe('INVALID_SIGNATURE');
    }
  });

  it('throws INVALID_SIGNATURE for a signature of the wrong length', () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);
    try {
      // 100 hex chars after 0x — not 128 or 130.
      recoverSetupSigner(payload, '0x' + 'aa'.repeat(50), KERNEL_ADDRESS);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryEip712Error).code).toBe('INVALID_SIGNATURE');
    }
  });

  it('throws INVALID_KERNEL_ADDRESS when kernel argument is malformed', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);
    const sig = await signSetup(wallet as unknown as ethers.Wallet, payload);
    try {
      recoverSetupSigner(payload, sig, '0xnope');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryEip712Error).code).toBe('INVALID_KERNEL_ADDRESS');
    }
  });
});

describe('delivery/eip712 — recoverEnvelopeSigner', () => {
  it('recovers the signer of an envelope payload to the expected EOA', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildEnvelopePayload(wallet as unknown as ethers.Wallet);
    const sig = await signEnvelope(wallet as unknown as ethers.Wallet, payload);
    const recovered = recoverEnvelopeSigner(payload, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('mutating scheme changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildEnvelopePayload(wallet as unknown as ethers.Wallet);
    const sig = await signEnvelope(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliveryEnvelopeSignedV1 = {
      ...payload,
      scheme: 'public-v1',
      providerEphemeralPubkey: CANONICAL_EMPTY_BYTES32,
      nonce: CANONICAL_EMPTY_BYTES12,
      tag: CANONICAL_EMPTY_BYTES16,
    };
    const recovered = recoverEnvelopeSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('mutating payloadHash changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildEnvelopePayload(wallet as unknown as ethers.Wallet);
    const sig = await signEnvelope(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliveryEnvelopeSignedV1 = {
      ...payload,
      payloadHash: ('0x' + 'ff'.repeat(32)) as `0x${string}`,
    };
    const recovered = recoverEnvelopeSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('mutating nonce changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildEnvelopePayload(wallet as unknown as ethers.Wallet);
    const sig = await signEnvelope(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliveryEnvelopeSignedV1 = {
      ...payload,
      nonce: ('0x' + '99'.repeat(12)) as `0x${string}`,
    };
    const recovered = recoverEnvelopeSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('mutating tag changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildEnvelopePayload(wallet as unknown as ethers.Wallet);
    const sig = await signEnvelope(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliveryEnvelopeSignedV1 = {
      ...payload,
      tag: ('0x' + '88'.repeat(16)) as `0x${string}`,
    };
    const recovered = recoverEnvelopeSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('mutating providerEphemeralPubkey changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildEnvelopePayload(wallet as unknown as ethers.Wallet);
    const sig = await signEnvelope(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliveryEnvelopeSignedV1 = {
      ...payload,
      providerEphemeralPubkey: ('0x' + '77'.repeat(32)) as `0x${string}`,
    };
    const recovered = recoverEnvelopeSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('mutating createdAt changes the recovered address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildEnvelopePayload(wallet as unknown as ethers.Wallet);
    const sig = await signEnvelope(wallet as unknown as ethers.Wallet, payload);
    const tampered: DeliveryEnvelopeSignedV1 = {
      ...payload,
      createdAt: payload.createdAt + 1,
    };
    const recovered = recoverEnvelopeSigner(tampered, sig, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('throws INVALID_SIGNATURE for empty signature', () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildEnvelopePayload(wallet as unknown as ethers.Wallet);
    try {
      recoverEnvelopeSigner(payload, '', KERNEL_ADDRESS);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DeliveryEip712Error).code).toBe('INVALID_SIGNATURE');
    }
  });
});

describe('delivery/eip712 — cross-feature domain separation', () => {
  it('signature produced under AGIRAILS Receipts domain does NOT recover under AGIRAILS Delivery domain', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);

    // Sign with the WRONG (receipts) domain — but the same types and payload.
    const receiptsDomain = {
      name: 'AGIRAILS Receipts',
      version: '1',
      chainId: CHAIN_ID_SEPOLIA,
      verifyingContract: KERNEL_ADDRESS,
    };
    const sigUnderWrongDomain = await wallet.signTypedData(
      receiptsDomain,
      DELIVERY_SETUP_TYPES_V1,
      payload,
    );

    // Now verify under the delivery domain — the recovered address MUST differ
    // from the actual signer. (It will be a deterministic but unrelated EOA
    // derived from the signature/payload-hash pair under the wrong domain.)
    const recovered = recoverSetupSigner(payload, sigUnderWrongDomain, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('signature produced under the negotiation domain (AGIRAILS) does NOT recover under delivery', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);

    const negotiationDomain = {
      name: 'AGIRAILS',
      version: '1',
      chainId: CHAIN_ID_SEPOLIA,
      verifyingContract: KERNEL_ADDRESS,
    };
    const sigUnderNegotiation = await wallet.signTypedData(
      negotiationDomain,
      DELIVERY_SETUP_TYPES_V1,
      payload,
    );
    const recovered = recoverSetupSigner(payload, sigUnderNegotiation, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('signature produced under a different verifyingContract does NOT recover with the canonical kernel', async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = buildSetupPayload(wallet as unknown as ethers.Wallet);

    // All-lowercase passes ethers.isAddress (no checksum to validate).
    const attackerKernel = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const sigUnderAttackerKernel = await signSetup(
      wallet as unknown as ethers.Wallet,
      payload,
      attackerKernel,
    );

    // Recovering with the canonical kernel — the recovered address MUST differ
    // from `wallet.address`, defending the relay's kernel allowlist.
    const recovered = recoverSetupSigner(payload, sigUnderAttackerKernel, KERNEL_ADDRESS);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });
});

describe('delivery/eip712 — DeliveryEip712Error class', () => {
  it('extends Error with name DeliveryEip712Error', () => {
    const err = new DeliveryEip712Error('TEST_CODE', 'msg');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DeliveryEip712Error');
  });

  it('exposes code and message', () => {
    const err = new DeliveryEip712Error('TEST_CODE', 'hello');
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('hello');
  });

  it('preserves details', () => {
    const err = new DeliveryEip712Error('TEST_CODE', 'm', { foo: 1 });
    expect(err.details).toEqual({ foo: 1 });
  });

  it('survives instanceof across explicit prototype chain restoration', () => {
    const err = new DeliveryEip712Error('TEST_CODE', 'm');
    expect(err instanceof DeliveryEip712Error).toBe(true);
  });
});
