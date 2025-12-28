import { AbiCoder, Wallet, ethers } from 'ethers';
import { EASHelper } from './EASHelper';
import { InMemoryUsedAttestationTracker } from '../utils/UsedAttestationTracker';

describe('EASHelper.verifyDeliveryAttestation() (AIP-6 + replay protection)', () => {
  test('accepts AIP-6 test schema payload and records usage', async () => {
    const txId = ethers.ZeroHash;
    const attUID = '0x' + '11'.repeat(32);
    const schemaUID = '0x' + '22'.repeat(32);

    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'string', 'bytes32', 'uint256', 'uint256'],
      [txId, 'QmT5NvUtoM5nWFfrQdVrFtvGfKFmG7AHE8P34isapyhCxX', ethers.keccak256(ethers.toUtf8Bytes('x')), 123n, 456n]
    );

    const tracker = new InMemoryUsedAttestationTracker();
    const helper = new EASHelper(
      Wallet.createRandom(),
      { contractAddress: '0x4200000000000000000000000000000000000021', deliveryProofSchemaId: schemaUID },
      tracker
    );

    // Stub the EAS client
    (helper as any).eas = {
      getAttestation: async () => ({
        uid: attUID,
        schema: schemaUID,
        expirationTime: 0,
        revocationTime: 0,
        data: encoded,
      }),
    };

    await expect(helper.verifyDeliveryAttestation(txId, attUID)).resolves.toBe(true);
    expect(tracker.getUsageForAttestation(attUID)).toBe(txId);
  });

  test('rejects revoked attestations (revocationTime > 0)', async () => {
    const txId = ethers.ZeroHash;
    const attUID = '0x' + '33'.repeat(32);
    const schemaUID = '0x' + '44'.repeat(32);

    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'string', 'bytes32', 'uint256'],
      [txId, 'bafy...', ethers.keccak256(ethers.toUtf8Bytes('x')), 123n]
    );

    const helper = new EASHelper(
      Wallet.createRandom(),
      { contractAddress: '0x4200000000000000000000000000000000000021', deliveryProofSchemaId: schemaUID },
      new InMemoryUsedAttestationTracker()
    );

    (helper as any).eas = {
      getAttestation: async () => ({
        uid: attUID,
        schema: schemaUID,
        expirationTime: 0,
        revocationTime: 1,
        data: encoded,
      }),
    };

    await expect(helper.verifyDeliveryAttestation(txId, attUID)).rejects.toThrow('revoked');
  });
});









