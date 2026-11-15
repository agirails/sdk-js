/**
 * EvidenceArtifactV2 (Schema 2.0.0, AIP-14c D5/D6) — canonical serializer golden tests.
 *
 * The GOLDEN canonical string + hash below anchor the frozen canonicalization
 * (sorted keys, no whitespace, raw UTF-8 — same canonicalizer as the 1.0.0 bundle).
 * If either changes, every already-signed 9-field ruling's bundleHash breaks —
 * treat a diff here as an ABI-freeze-level event, not a test to update.
 */

import { keccak256, toUtf8Bytes } from 'ethers';

import {
  EVIDENCE_ARTIFACT_V2_SCHEMA_VERSION,
  InvalidArtifactError,
  UnsupportedArtifactVersionError,
  computeArtifactV2Hash,
  serializeArtifactV2ToString,
  validateEvidenceArtifactV2,
} from '../src/dispute/EvidenceArtifactV2';

const D = '0x' + '11'.repeat(32);
const T = '0x' + '22'.repeat(32);
const R = '0x' + '33'.repeat(32);
const A = '0x' + '44'.repeat(32);
const REQ = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const PRV = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

function artifact(): Record<string, any> {
  return {
    schemaVersion: '2.0.0',
    disputeId: D,
    transaction: {
      transactionId: T,
      parties: { requester: REQ, provider: PRV },
      amount: '1000000000',
      initiator: REQ,
      timestamps: { createdAt: 1700000000, deliveredAt: 1700000100, disputedAt: 1700000200 },
    },
    agreement: { bytes: 'AGREEMENT: request+input+SLA', quote: { bytes: 'QUOTE: 1000 USDC', quoteHash: A } },
    delivery: { resultHash: R, inline: 'DELIVERABLE: content' },
  };
}

describe('EvidenceArtifactV2 canonical serializer (2.0.0)', () => {
  it('golden: canonical string is key-sorted, whitespace-free, and stable', () => {
    const text = serializeArtifactV2ToString(artifact());
    const expected =
      '{"agreement":{"bytes":"AGREEMENT: request+input+SLA","quote":{"bytes":"QUOTE: 1000 USDC",' +
      `"quoteHash":"${A}"}},"delivery":{"inline":"DELIVERABLE: content","resultHash":"${R}"},` +
      `"disputeId":"${D}","schemaVersion":"2.0.0","transaction":{"amount":"1000000000",` +
      `"initiator":"${REQ}","parties":{"provider":"${PRV}","requester":"${REQ}"},` +
      `"timestamps":{"createdAt":1700000000,"deliveredAt":1700000100,"disputedAt":1700000200},` +
      `"transactionId":"${T}"}}`;
    expect(text).toBe(expected);
    expect(computeArtifactV2Hash(artifact(), { skipTokenCheck: true })).toBe(keccak256(toUtf8Bytes(expected)));
  });

  it('hash is insensitive to source key order (canonicalization)', () => {
    const reordered = { delivery: artifact().delivery, transaction: artifact().transaction, agreement: artifact().agreement, disputeId: D, schemaVersion: '2.0.0' };
    expect(computeArtifactV2Hash(reordered, { skipTokenCheck: true })).toBe(
      computeArtifactV2Hash(artifact(), { skipTokenCheck: true })
    );
  });

  it('accepts agreement.cid without bytes; rejects neither', () => {
    const a = artifact();
    delete a.agreement.bytes;
    a.agreement.cid = 'bafy-agreement';
    expect(() => validateEvidenceArtifactV2(a)).not.toThrow();
    delete a.agreement.cid;
    expect(() => validateEvidenceArtifactV2(a)).toThrow(InvalidArtifactError);
  });

  it('strict version: any non-exact 2.x is rejected', () => {
    for (const v of ['2.0.1', '2.1.0', '1.0.0', '']) {
      const a = artifact();
      a.schemaVersion = v;
      expect(() => validateEvidenceArtifactV2(a)).toThrow(
        v === '' ? InvalidArtifactError : UnsupportedArtifactVersionError
      );
    }
    expect(EVIDENCE_ARTIFACT_V2_SCHEMA_VERSION).toBe('2.0.0');
  });

  it('rejects forbidden D6/D5 keys and any unknown key at any level', () => {
    for (const mutate of [
      (a: any) => (a.reasoning = { notes: 'smuggled' }),
      (a: any) => (a.timeline = []),
      (a: any) => (a.extra = 1),
      (a: any) => (a.transaction.extra = 1),
      (a: any) => (a.delivery.extra = 1),
      (a: any) => (a.agreement.quote.extra = 1),
    ]) {
      const a = artifact();
      mutate(a);
      expect(() => validateEvidenceArtifactV2(a)).toThrow(InvalidArtifactError);
    }
  });

  it('rejects malformed bytes32hex / address / amount / timestamps', () => {
    for (const mutate of [
      (a: any) => (a.disputeId = '0xAB'.padEnd(66, 'G')),
      (a: any) => (a.disputeId = D.toUpperCase()),
      (a: any) => (a.transaction.parties.requester = 'not-an-address'),
      (a: any) => (a.transaction.amount = '1.5'),
      (a: any) => (a.transaction.timestamps.createdAt = 1.5),
      (a: any) => (a.delivery.resultHash = '0x1234'),
    ]) {
      const a = artifact();
      mutate(a);
      expect(() => validateEvidenceArtifactV2(a)).toThrow(InvalidArtifactError);
    }
  });
});
