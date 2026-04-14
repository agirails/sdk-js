/**
 * ACTPClient Lazy Publish Tests
 *
 * Tests cover:
 * - detectLazyPublishScenario() for all 5 outcomes
 * - Mock mode auto-address generation
 */

import { ethers } from 'ethers';
import { detectLazyPublishScenario } from './ACTPClient';
import { PendingPublish } from './config/pendingPublish';
import { ACTPClient } from './ACTPClient';

const ZERO_HASH = '0x' + '0'.repeat(64);
const CONFIG_HASH_A = '0x' + 'aa'.repeat(32);
const CONFIG_HASH_B = '0x' + 'bb'.repeat(32);

const SAMPLE_PENDING: PendingPublish = {
  version: 1,
  configHash: CONFIG_HASH_A,
  cid: 'bafybeiexamplecid',
  endpoint: 'https://agent.example.com',
  serviceDescriptors: [
    {
      serviceTypeHash: ethers.keccak256(ethers.toUtf8Bytes('text-generation')),
      serviceType: 'text-generation',
      schemaURI: '',
      minPrice: 0n,
      maxPrice: 1_000_000_000n,
      avgCompletionTime: 3600,
      metadataCID: '',
    },
  ],
  createdAt: '2026-02-11T12:00:00.000Z',
};

describe('detectLazyPublishScenario', () => {
  it('should return "none" when no pending publish', () => {
    const scenario = detectLazyPublishScenario(
      { registeredAt: 100n, configHash: CONFIG_HASH_A, listed: true },
      null
    );
    expect(scenario).toBe('none');
  });

  it('should return "A" when not registered + has pending', () => {
    const scenario = detectLazyPublishScenario(
      { registeredAt: 0n, configHash: ZERO_HASH, listed: false },
      SAMPLE_PENDING
    );
    expect(scenario).toBe('A');
  });

  it('should return "B1" when registered + hash differs + not listed', () => {
    const scenario = detectLazyPublishScenario(
      { registeredAt: 100n, configHash: CONFIG_HASH_B, listed: false },
      SAMPLE_PENDING // has CONFIG_HASH_A
    );
    expect(scenario).toBe('B1');
  });

  it('should return "B2" when registered + hash differs + already listed', () => {
    const scenario = detectLazyPublishScenario(
      { registeredAt: 100n, configHash: CONFIG_HASH_B, listed: true },
      SAMPLE_PENDING // has CONFIG_HASH_A
    );
    expect(scenario).toBe('B2');
  });

  it('should return "C" when registered + hash matches (stale pending)', () => {
    const scenario = detectLazyPublishScenario(
      { registeredAt: 100n, configHash: CONFIG_HASH_A, listed: true },
      SAMPLE_PENDING // same CONFIG_HASH_A
    );
    expect(scenario).toBe('C');
  });
});

describe('ACTPClient mock mode', () => {
  it('should auto-generate requesterAddress when not provided', async () => {
    const client = await ACTPClient.create({
      mode: 'mock',
      // No requesterAddress!
    });

    const address = client.getAddress();
    // Should be a valid EIP-55 checksummed hex address
    expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('should still accept explicit requesterAddress', async () => {
    const addr = '0x' + '11'.repeat(20);
    const client = await ACTPClient.create({
      mode: 'mock',
      requesterAddress: addr,
    });
    expect(client.getAddress()).toBe(addr.toLowerCase());
  });
});
