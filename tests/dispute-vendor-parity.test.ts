/**
 * P2-2 — Dispute-contract ABI + network-config vendoring parity (TS side).
 *
 * Asserts three things, all of which MUST hold identically in the Python SDK
 * (python-sdk-v2/tests/test_cross_sdk/test_dispute_vendor_parity.py):
 *
 *   1. The 3 vendored dispute ABIs (BondEscalation, CompositeMediator,
 *      IOptimisticOracleV3) load and expose their key on-chain surface.
 *   2. The network config carries the 3 dispute-contract keys
 *      (bondEscalation, compositeMediator, umaOptimisticOracleV3) and they
 *      resolve to `undefined` until deployed (testnet Phase 6, mainnet later).
 *   3. The cross-SDK GOLDEN EIP-712 vector reproduces the FROZEN digest
 *      (the same constant the Solidity EncodingCanonical.t.sol and the Python
 *      SDK reproduce) — the cross-language anchor.
 */

import fs from 'fs';
import path from 'path';
import { Interface } from 'ethers';

import BondEscalationABI from '../src/abi/BondEscalation.json';
import CompositeMediatorABI from '../src/abi/CompositeMediator.json';
import IOptimisticOracleV3ABI from '../src/abi/IOptimisticOracleV3.json';

import { getNetwork, NETWORKS } from '../src/config/networks';
import { AIRuling, Ruling, computeRulingDigest, computeRulingDomainSeparator, computeRulingStructHash } from '../src/types/dispute';

const GOLDEN = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'cross_sdk', 'dispute_golden_vector.json'),
    'utf8'
  )
);

describe('P2-2 dispute ABIs vendored (TS)', () => {
  test('BondEscalation ABI loads + exposes the AIRuling verifier surface', () => {
    const iface = new Interface(BondEscalationABI as any);
    expect(iface.getFunction('DOMAIN_SEPARATOR')).not.toBeNull();
    expect(iface.getFunction('submitAIRuling')).not.toBeNull();
    expect(iface.getFunction('openDispute')).not.toBeNull();
    expect(iface.getFunction('finalize')).not.toBeNull();
  });

  test('CompositeMediator ABI loads + exposes resolve()', () => {
    const iface = new Interface(CompositeMediatorABI as any);
    expect(iface.getFunction('resolve')).not.toBeNull();
    expect(iface.getFunction('kernel')).not.toBeNull();
    expect(iface.getFunction('bondEscalation')).not.toBeNull();
  });

  test('IOptimisticOracleV3 ABI loads + exposes the UMA OOv3 surface', () => {
    const iface = new Interface(IOptimisticOracleV3ABI as any);
    expect(iface.getFunction('assertTruth')).not.toBeNull();
    expect(iface.getFunction('settleAndGetAssertionResult')).not.toBeNull();
    expect(iface.getFunction('getMinimumBond')).not.toBeNull();
  });
});

describe('P2-2 network-config dispute keys (TS)', () => {
  const DISPUTE_KEYS = ['bondEscalation', 'compositeMediator', 'umaOptimisticOracleV3'] as const;

  test('fixture lists the canonical dispute config keys (parity anchor)', () => {
    expect(GOLDEN.contracts.keys).toEqual(DISPUTE_KEYS);
  });

  const DEPLOYED_BASE_SEPOLIA = {
    bondEscalation: '0x1F89966780a09daE562d17D0aDd45E7E8BC7E992',
    compositeMediator: '0xB2C6317752B7CB5Aff56114f6D4183Ba3B9c088A',
    umaOptimisticOracleV3: '0x07fD9Cb968f9A0aef5CEB2D536322f26164B83b8',
  } as const;

  test.each(['base-sepolia', 'base-mainnet'])(
    '%s exposes all 3 dispute keys (full D7 stack on sepolia incl. MockOOV3, all undefined on mainnet)',
    (network) => {
      const cfg = getNetwork(network);
      for (const key of DISPUTE_KEYS) {
        // The key must exist on the contracts object (present in the type).
        expect(key in cfg.contracts).toBe(true);
      }
      const contracts = cfg.contracts as Record<string, unknown>;
      if (network === 'base-sepolia') {
        expect(contracts.bondEscalation).toBe(DEPLOYED_BASE_SEPOLIA.bondEscalation);
        expect(contracts.compositeMediator).toBe(DEPLOYED_BASE_SEPOLIA.compositeMediator);
        expect(contracts.umaOptimisticOracleV3).toBe(DEPLOYED_BASE_SEPOLIA.umaOptimisticOracleV3);
      } else {
        // Mainnet: none of the dispute contracts are deployed yet.
        for (const key of DISPUTE_KEYS) {
          expect(contracts[key]).toBeUndefined();
        }
      }
    }
  );

  test('both networks present in registry', () => {
    expect(Object.keys(NETWORKS).sort()).toEqual(['base-mainnet', 'base-sepolia']);
  });
});

describe('P2-2 GOLDEN EIP-712 vector (TS ↔ Py ↔ Solidity anchor)', () => {
  const ruling: AIRuling = {
    disputeId: GOLDEN.ruling.disputeId,
    ruling: GOLDEN.ruling.ruling as Ruling,
    confidence: GOLDEN.ruling.confidence,
    splitBps: GOLDEN.ruling.splitBps,
    timestamp: GOLDEN.ruling.timestamp,
    reasoningHash: GOLDEN.ruling.reasoningHash,
    bundleHash: GOLDEN.ruling.bundleHash,
    evidenceRefHash: GOLDEN.ruling.evidenceRefHash,
    reasoningRefHash: GOLDEN.ruling.reasoningRefHash,
  };
  const { chainId, verifyingContract } = GOLDEN.domain;

  test('domain separator matches frozen GOLDEN_DOMAIN_SEPARATOR', () => {
    expect(computeRulingDomainSeparator(chainId, verifyingContract)).toBe(
      GOLDEN.expected.domainSeparator
    );
  });

  test('struct hash matches frozen GOLDEN_STRUCT_HASH', () => {
    expect(computeRulingStructHash(ruling)).toBe(GOLDEN.expected.structHash);
  });

  test('digest matches frozen GOLDEN_DIGEST', () => {
    expect(computeRulingDigest(ruling, chainId, verifyingContract)).toBe(
      GOLDEN.expected.digest
    );
  });
});
