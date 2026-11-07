import { ethers } from 'ethers';
import {
  AIRuling,
  Ruling,
  Tier,
  RULING_TYPEHASH,
  computeRulingDigest,
  computeRulingDomainSeparator,
  computeRulingStructHash,
  signRuling,
  recoverRulingSigner
} from './dispute';

/**
 * GOLDEN VECTOR — the cross-language EIP-712 anchor.
 *
 * Source of truth: Protocol/actp-kernel/test/EncodingCanonical.t.sol.
 * The SDK MUST reproduce these byte-for-byte; if any value drifts, the SDK
 * encoding is wrong — fix the encoding, NOT the golden constants.
 */
const GOLDEN_CHAIN_ID = 8453; // Base mainnet
const GOLDEN_VERIFYING_CONTRACT = '0x3c68CC8dFe901c7e89eC9f738F9a81709E6e7737';

// Fixed AIRuling field values (AIP-14c 9-field order — load-bearing).
const GOLDEN_RULING: AIRuling = {
  disputeId: ethers.keccak256(ethers.toUtf8Bytes('ACTP_GOLDEN_VECTOR_DISPUTE')),
  ruling: 1, // requester wins
  confidence: 9500, // 95%
  splitBps: 0,
  timestamp: 1_700_000_000,
  reasoningHash: ethers.keccak256(ethers.toUtf8Bytes('golden-reasoning')),
  bundleHash: ethers.keccak256(ethers.toUtf8Bytes('golden-bundle')),
  evidenceRefHash: ethers.keccak256(ethers.toUtf8Bytes('golden-evidence-ref')),
  reasoningRefHash: ethers.keccak256(ethers.toUtf8Bytes('golden-reasoning-ref'))
};

// FROZEN EXPECTED VALUES — copied verbatim from EncodingCanonical.t.sol /
// deployments/AIP14C-ABI-FREEZE.md (AIP-14c 9-field type).
const EXPECTED_RULING_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    'AIRuling(bytes32 disputeId,uint8 ruling,uint16 confidence,uint16 splitBps,uint64 timestamp,bytes32 reasoningHash,bytes32 bundleHash,bytes32 evidenceRefHash,bytes32 reasoningRefHash)'
  )
);
const GOLDEN_DOMAIN_SEPARATOR =
  '0x49c919619319169442e048297d8b8dc2f0c6a78b8601c78a39656bc2b3b25db8';
const GOLDEN_STRUCT_HASH =
  '0x2b30b25ad0258f200a315a68b1a7ebffc4040679fca1a4bbdf1cae0b57c589b4';
const GOLDEN_DIGEST =
  '0xc14778f377cd385dd4686b798cb2a010c8ff95e8a35a4f170af7e05bc8c2d8a0';

describe('dispute — GOLDEN VECTOR (EIP-712 cross-language anchor)', () => {
  it('RULING_TYPEHASH matches the canonical AIRuling type string', () => {
    expect(RULING_TYPEHASH).toBe(EXPECTED_RULING_TYPEHASH);
  });

  it('RULING_TYPEHASH equals the frozen AIP-14c literal', () => {
    expect(RULING_TYPEHASH).toBe(
      '0x00e11bf3b34994a6bc6e216b116cbdaddee1227d0c97d46416f8d994ba8420ae'
    );
  });

  it('evidenceRefHash / reasoningRefHash are load-bearing (omitting them changes the digest)', () => {
    const withoutRefs: AIRuling = {
      disputeId: GOLDEN_RULING.disputeId,
      ruling: GOLDEN_RULING.ruling,
      confidence: GOLDEN_RULING.confidence,
      splitBps: GOLDEN_RULING.splitBps,
      timestamp: GOLDEN_RULING.timestamp,
      reasoningHash: GOLDEN_RULING.reasoningHash,
      bundleHash: GOLDEN_RULING.bundleHash
      // evidenceRefHash / reasoningRefHash omitted → default bytes32(0)
    };
    const digestNoRefs = computeRulingDigest(
      withoutRefs,
      GOLDEN_CHAIN_ID,
      GOLDEN_VERIFYING_CONTRACT
    );
    // Zero-ref digest is well-defined but MUST differ from the golden digest,
    // proving the two ref fields are hashed into the signature.
    expect(digestNoRefs).not.toBe(GOLDEN_DIGEST);
  });

  it('domainSeparator equals GOLDEN_DOMAIN_SEPARATOR', () => {
    const ds = computeRulingDomainSeparator(GOLDEN_CHAIN_ID, GOLDEN_VERIFYING_CONTRACT);
    expect(ds).toBe(GOLDEN_DOMAIN_SEPARATOR);
  });

  it('structHash equals GOLDEN_STRUCT_HASH', () => {
    const sh = computeRulingStructHash(GOLDEN_RULING);
    expect(sh).toBe(GOLDEN_STRUCT_HASH);
  });

  it('digest equals GOLDEN_DIGEST', () => {
    const digest = computeRulingDigest(
      GOLDEN_RULING,
      GOLDEN_CHAIN_ID,
      GOLDEN_VERIFYING_CONTRACT
    );
    expect(digest).toBe(GOLDEN_DIGEST);
  });

  it('digest = keccak256(0x1901 || domainSeparator || structHash)', () => {
    const ds = computeRulingDomainSeparator(GOLDEN_CHAIN_ID, GOLDEN_VERIFYING_CONTRACT);
    const sh = computeRulingStructHash(GOLDEN_RULING);
    const digest = ethers.keccak256(ethers.concat(['0x1901', ds, sh]));
    expect(digest).toBe(GOLDEN_DIGEST);
    expect(digest).toBe(
      computeRulingDigest(GOLDEN_RULING, GOLDEN_CHAIN_ID, GOLDEN_VERIFYING_CONTRACT)
    );
  });

  it('signRuling produces a signature that recoverRulingSigner round-trips to the signer', async () => {
    const wallet = ethers.Wallet.createRandom();
    const sig = await signRuling(
      GOLDEN_RULING,
      wallet,
      GOLDEN_CHAIN_ID,
      GOLDEN_VERIFYING_CONTRACT
    );
    const recovered = recoverRulingSigner(
      GOLDEN_RULING,
      sig,
      GOLDEN_CHAIN_ID,
      GOLDEN_VERIFYING_CONTRACT
    );
    expect(recovered).toBe(wallet.address);
  });

  it('a signature over the golden digest ecrecovers the golden signer (contract-path parity)', async () => {
    // Mirror EncodingCanonical.t.sol step (c): sign GOLDEN_DIGEST raw and ecrecover.
    const wallet = ethers.Wallet.createRandom();
    const digest = computeRulingDigest(
      GOLDEN_RULING,
      GOLDEN_CHAIN_ID,
      GOLDEN_VERIFYING_CONTRACT
    );
    expect(digest).toBe(GOLDEN_DIGEST);

    const sig = wallet.signingKey.sign(digest).serialized;
    const recovered = ethers.recoverAddress(digest, sig);
    expect(recovered).toBe(wallet.address);
  });

  it('Ruling enum mapping is load-bearing (REQUESTER_WINS === 1 matches golden)', () => {
    expect(Ruling.PROVIDER_WINS).toBe(0);
    expect(Ruling.REQUESTER_WINS).toBe(1);
    expect(Ruling.SPLIT).toBe(2);
    expect(GOLDEN_RULING.ruling).toBe(Ruling.REQUESTER_WINS);
  });

  it('Tier enum is 0-based and matches BondEscalation.sol d.tier (TIER1 === on-chain 1)', () => {
    // Negative control: the on-chain BondEscalation `d.tier` field is 0-based
    // (opened=0 → proposal=1 → UMA=2). TIER1 MUST equal the on-chain value 1,
    // NOT 2 — a 1-based enum would misclassify every tier the moment a
    // disputes()/d.tier reader is wired. Py twin asserts the identical mapping.
    expect(Tier.TIER0).toBe(0);
    expect(Tier.TIER1).toBe(1);
    expect(Tier.TIER2).toBe(2);
  });
});
