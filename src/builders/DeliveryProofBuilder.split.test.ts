/**
 * AIP-16 Phase 2e — DeliveryProofBuilder DEC-3 split tests.
 *
 * Covers:
 *  - `buildPublicProof` retains AIP-4 behavior: plaintext to IPFS, plaintext
 *    hash as EAS resultHash.
 *  - `buildEncryptedProof` (DEC-3 variant): only the encrypted envelope wire
 *    is uploaded to IPFS; plaintext NEVER leaves the channel; EAS attestation
 *    references envelope hash.
 *  - `build()` is preserved as an alias of `buildPublicProof` for AIP-4
 *    backward compatibility.
 *  - Consistency checks on txId / chainId mismatch in the encrypted variant.
 *
 * The tests mock IPFS, EAS, and the signer; they exercise the orchestration
 * inside the builder rather than the cryptographic primitives (which have
 * their own dedicated coverage).
 */

import { HDNodeWallet, Wallet, keccak256, toUtf8Bytes } from 'ethers';

import {
  AGIRAILS_DELIVERY_SCHEMA_UID,
  DeliveryProofBuilder,
  type DeliveryProofParams,
  type DeliveryProofEncryptedParams,
} from './DeliveryProofBuilder';
import { DeliveryEnvelopeBuilder } from '../delivery/envelopeBuilder';
import { generateEphemeralKeyPair } from '../delivery/keys';
import type {
  DeliveryEnvelopeWireV1,
} from '../delivery/types';
import { canonicalJsonStringify } from '../utils/canonicalJson';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const KERNEL = '0x469CBADbACFFE096270594F0a31f0EEC53753411' as const;
const CHAIN_ID = 84532;
const ATTEST_UID = '0x' + 'a'.repeat(64);

interface MockIPFS {
  add: jest.Mock;
  pin: jest.Mock;
}
interface MockEAS {
  attest: jest.Mock;
  getAttestation: jest.Mock;
}
interface MockNonce {
  getNextNonce: jest.Mock;
  recordNonce: jest.Mock;
}

function makeMockIPFS(): MockIPFS {
  let counter = 0;
  return {
    add: jest.fn().mockImplementation(async () => {
      counter += 1;
      return `QmCID${counter}`;
    }),
    pin: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMockEAS(): MockEAS {
  return {
    attest: jest.fn().mockResolvedValue({
      wait: jest.fn().mockResolvedValue({ newAttestationUID: ATTEST_UID }),
    }),
    getAttestation: jest.fn(),
  };
}

function makeMockNonce(): MockNonce {
  let n = 0;
  return {
    getNextNonce: jest.fn().mockImplementation(() => {
      n += 1;
      return '0x' + n.toString(16).padStart(64, '0');
    }),
    recordNonce: jest.fn(),
  };
}

async function buildEnvelopeWire(
  providerWallet: HDNodeWallet,
  txId: string,
  payload: unknown,
  scheme: 'public-v1' | 'x25519-aes256gcm-v1' = 'public-v1',
): Promise<DeliveryEnvelopeWireV1> {
  const builder = new DeliveryEnvelopeBuilder(providerWallet);
  if (scheme === 'public-v1') {
    const { wire } = await builder.buildPublic({
      txId: txId as `0x${string}`,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL,
      providerAddress: providerWallet.address as `0x${string}`,
      signerAddress: providerWallet.address as `0x${string}`,
      payload,
    });
    return wire;
  }
  const kp = generateEphemeralKeyPair();
  const { wire } = await builder.buildEncrypted({
    txId: txId as `0x${string}`,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL,
    providerAddress: providerWallet.address as `0x${string}`,
    signerAddress: providerWallet.address as `0x${string}`,
    payload,
    buyerEphemeralPubkey: kp.publicKeyHex,
  });
  return wire;
}

function defaultPublicParams(providerAddress: string): DeliveryProofParams {
  return {
    txId: '0x' + '1'.repeat(64),
    provider: `did:ethr:${providerAddress}`,
    consumer: 'did:ethr:0x' + '2'.repeat(40),
    resultData: { result: 'ok', value: 42 },
    chainId: CHAIN_ID,
    kernelAddress: KERNEL,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AIP-16 Phase 2e — DeliveryProofBuilder DEC-3 split', () => {
  let providerWallet: HDNodeWallet;

  beforeEach(() => {
    providerWallet = Wallet.createRandom();
  });

  // -------------------------------------------------------------------------
  // buildPublicProof — original AIP-4 behavior
  // -------------------------------------------------------------------------

  describe('buildPublicProof', () => {
    it('uploads the PLAINTEXT result JSON to IPFS (first call)', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const params = defaultPublicParams(providerWallet.address);
      await builder.buildPublicProof(params);

      // Two add() calls total: (1) plaintext result, (2) signed proof JSON.
      expect(ipfs.add).toHaveBeenCalledTimes(2);
      expect(ipfs.pin).toHaveBeenCalledTimes(2);
      expect(ipfs.add).toHaveBeenNthCalledWith(
        1,
        JSON.stringify(params.resultData),
      );
    });

    it('uses keccak256(canonical JSON) of plaintext as the EAS resultHash', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const params = defaultPublicParams(providerWallet.address);
      const result = await builder.buildPublicProof(params);

      const expectedHash = keccak256(
        toUtf8Bytes(canonicalJsonStringify(params.resultData)),
      );
      expect(result.deliveryProof.resultHash).toBe(expectedHash);
    });

    it('emits the canonical AIP-4 EAS schema UID', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      await builder.buildPublicProof(defaultPublicParams(providerWallet.address));

      expect(eas.attest).toHaveBeenCalledWith(
        expect.objectContaining({ schema: AGIRAILS_DELIVERY_SCHEMA_UID }),
      );
    });

    it('attaches the IPFS CID of the plaintext result as resultCID', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const r = await builder.buildPublicProof(
        defaultPublicParams(providerWallet.address),
      );

      // First add() returns "QmCID1" → that's the resultCID.
      expect(r.deliveryProof.resultCID).toBe('QmCID1');
    });

    it('returns attestationUID from the EAS receipt', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const r = await builder.buildPublicProof(
        defaultPublicParams(providerWallet.address),
      );
      expect(r.attestationUID).toBe(ATTEST_UID);
    });
  });

  // -------------------------------------------------------------------------
  // buildEncryptedProof — DEC-3 variant
  // -------------------------------------------------------------------------

  describe('buildEncryptedProof', () => {
    it('uploads the FULL ENCRYPTED ENVELOPE WIRE JSON (NOT plaintext)', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const txId = '0x' + 'ab'.repeat(32);
      const envelopeWire = await buildEnvelopeWire(
        providerWallet,
        txId,
        { secret: 'top-secret-data' },
        'x25519-aes256gcm-v1',
      );

      const params: DeliveryProofEncryptedParams = {
        txId,
        provider: `did:ethr:${providerWallet.address}`,
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        envelopeWire,
        chainId: CHAIN_ID,
        kernelAddress: KERNEL,
      };

      await builder.buildEncryptedProof(params);

      // Two add() calls total: (1) encrypted envelope wire JSON, (2) signed
      // delivery proof JSON.
      expect(ipfs.add).toHaveBeenCalledTimes(2);
      // Argument 1 MUST be the wire JSON, NOT the plaintext.
      const firstUpload = (ipfs.add.mock.calls[0]?.[0] as string) ?? '';
      expect(firstUpload).toContain(envelopeWire.providerSig);
      expect(firstUpload).toContain(envelopeWire.signed.txId);
      // Plaintext "top-secret-data" MUST NOT appear in the upload.
      expect(firstUpload).not.toContain('top-secret-data');
    });

    it('uses envelopeHash (computeHash(wire)) as EAS resultHash', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const txId = '0x' + 'cd'.repeat(32);
      const envelopeWire = await buildEnvelopeWire(
        providerWallet,
        txId,
        { hidden: 'payload' },
        'x25519-aes256gcm-v1',
      );

      const expectedEnvelopeHash =
        DeliveryEnvelopeBuilder.computeHash(envelopeWire);

      const r = await builder.buildEncryptedProof({
        txId,
        provider: `did:ethr:${providerWallet.address}`,
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        envelopeWire,
        chainId: CHAIN_ID,
        kernelAddress: KERNEL,
      });

      expect(r.envelopeHash).toBe(expectedEnvelopeHash);
      expect(r.deliveryProof.resultHash).toBe(expectedEnvelopeHash);
    });

    it('returns encryptedEnvelopeCID separately from the proof CID', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const txId = '0x' + 'ee'.repeat(32);
      const envelopeWire = await buildEnvelopeWire(
        providerWallet,
        txId,
        { x: 1 },
        'x25519-aes256gcm-v1',
      );

      const r = await builder.buildEncryptedProof({
        txId,
        provider: `did:ethr:${providerWallet.address}`,
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        envelopeWire,
        chainId: CHAIN_ID,
        kernelAddress: KERNEL,
      });

      // First upload is the encrypted envelope; second is the signed proof.
      expect(r.encryptedEnvelopeCID).toBe('QmCID1');
      expect(r.deliveryProofCID).toBe('QmCID2');
      expect(r.encryptedEnvelopeCID).not.toBe(r.deliveryProofCID);
    });

    it('throws fast on txId mismatch (BEFORE any IPFS/EAS side effect)', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const txIdEnvelope = '0x' + 'aa'.repeat(32);
      const envelopeWire = await buildEnvelopeWire(
        providerWallet,
        txIdEnvelope,
        { ok: true },
        'public-v1',
      );

      await expect(
        builder.buildEncryptedProof({
          txId: '0x' + 'bb'.repeat(32), // mismatched
          provider: `did:ethr:${providerWallet.address}`,
          consumer: 'did:ethr:0x' + '2'.repeat(40),
          envelopeWire,
          chainId: CHAIN_ID,
          kernelAddress: KERNEL,
        }),
      ).rejects.toThrow(/txId mismatch/);

      expect(ipfs.add).not.toHaveBeenCalled();
      expect(eas.attest).not.toHaveBeenCalled();
    });

    it('throws fast on chainId mismatch (BEFORE any IPFS/EAS side effect)', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const txId = '0x' + 'aa'.repeat(32);
      const envelopeWire = await buildEnvelopeWire(
        providerWallet,
        txId,
        { ok: true },
        'public-v1',
      );

      await expect(
        builder.buildEncryptedProof({
          txId,
          provider: `did:ethr:${providerWallet.address}`,
          consumer: 'did:ethr:0x' + '2'.repeat(40),
          envelopeWire,
          chainId: 999, // mismatched
          kernelAddress: KERNEL,
        }),
      ).rejects.toThrow(/chainId mismatch/);

      expect(ipfs.add).not.toHaveBeenCalled();
      expect(eas.attest).not.toHaveBeenCalled();
    });

    it('NEVER hashes plaintext into the EAS resultHash (DEC-3 confidentiality invariant)', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const txId = '0x' + 'ff'.repeat(32);
      const plaintextPayload = { secret: 'super-secret-do-not-leak' };
      const envelopeWire = await buildEnvelopeWire(
        providerWallet,
        txId,
        plaintextPayload,
        'x25519-aes256gcm-v1',
      );

      const r = await builder.buildEncryptedProof({
        txId,
        provider: `did:ethr:${providerWallet.address}`,
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        envelopeWire,
        chainId: CHAIN_ID,
        kernelAddress: KERNEL,
      });

      // resultHash MUST be envelope hash, not plaintext hash.
      const plaintextHash = keccak256(
        toUtf8Bytes(canonicalJsonStringify(plaintextPayload)),
      );
      expect(r.deliveryProof.resultHash).not.toBe(plaintextHash);
      expect(r.deliveryProof.resultHash).toBe(
        DeliveryEnvelopeBuilder.computeHash(envelopeWire),
      );
    });

    it('passes the encrypted envelope CID to EAS as resultCID', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const txId = '0x' + '12'.repeat(32);
      const envelopeWire = await buildEnvelopeWire(
        providerWallet,
        txId,
        { x: 'y' },
        'x25519-aes256gcm-v1',
      );

      const r = await builder.buildEncryptedProof({
        txId,
        provider: `did:ethr:${providerWallet.address}`,
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        envelopeWire,
        chainId: CHAIN_ID,
        kernelAddress: KERNEL,
      });
      expect(r.deliveryProof.resultCID).toBe('QmCID1');
      expect(r.deliveryProof.resultCID).toBe(r.encryptedEnvelopeCID);
    });

    it('returns the AIP-4 schema UID for both variants (schema-level uniformity)', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const txId = '0x' + '34'.repeat(32);
      const envelopeWire = await buildEnvelopeWire(
        providerWallet,
        txId,
        { ok: 'enc' },
        'x25519-aes256gcm-v1',
      );

      await builder.buildEncryptedProof({
        txId,
        provider: `did:ethr:${providerWallet.address}`,
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        envelopeWire,
        chainId: CHAIN_ID,
        kernelAddress: KERNEL,
      });

      expect(eas.attest).toHaveBeenCalledWith(
        expect.objectContaining({ schema: AGIRAILS_DELIVERY_SCHEMA_UID }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // build() — backward-compat alias
  // -------------------------------------------------------------------------

  describe('build() backward compatibility', () => {
    it('build() delegates to buildPublicProof for legacy AIP-4 callers', async () => {
      const ipfs = makeMockIPFS();
      const eas = makeMockEAS();
      const nonce = makeMockNonce();
      const builder = new DeliveryProofBuilder(
        ipfs as never,
        providerWallet,
        nonce as never,
        eas as never,
      );

      const params = defaultPublicParams(providerWallet.address);
      const r = await builder.build(params);

      // Same shape as buildPublicProof:
      expect(r.deliveryProof).toBeDefined();
      expect(r.deliveryProofCID).toBeDefined();
      expect(r.attestationUID).toBe(ATTEST_UID);

      // Plaintext was uploaded.
      expect(ipfs.add).toHaveBeenNthCalledWith(
        1,
        JSON.stringify(params.resultData),
      );
    });

    it('build() and buildPublicProof produce structurally identical proofs', async () => {
      const ipfs1 = makeMockIPFS();
      const eas1 = makeMockEAS();
      const nonce1 = makeMockNonce();
      const b1 = new DeliveryProofBuilder(
        ipfs1 as never,
        providerWallet,
        nonce1 as never,
        eas1 as never,
      );

      const ipfs2 = makeMockIPFS();
      const eas2 = makeMockEAS();
      const nonce2 = makeMockNonce();
      const b2 = new DeliveryProofBuilder(
        ipfs2 as never,
        providerWallet,
        nonce2 as never,
        eas2 as never,
      );

      const params = defaultPublicParams(providerWallet.address);
      const a = await b1.build(params);
      const b = await b2.buildPublicProof(params);

      // resultCID, resultHash, txId are deterministic under matching inputs;
      // signature differs only by signer state which is the same instance.
      expect(a.deliveryProof.resultHash).toBe(b.deliveryProof.resultHash);
      expect(a.deliveryProof.resultCID).toBe(b.deliveryProof.resultCID);
      expect(a.deliveryProof.txId).toBe(b.deliveryProof.txId);
    });
  });
});
