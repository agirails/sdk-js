/**
 * ReputationReporter Unit Tests
 *
 * Tests the ERC-8004 Reputation Registry reporter:
 * - reportSettlement() - Report successful ACTP settlements
 * - reportDispute() - Report dispute resolutions
 * - Replay protection
 * - Error handling (never throws, returns null)
 *
 * @module erc8004/ReputationReporter.test
 */

import {
  ReputationReporter,
  IERC8004ReputationRegistry,
} from './ReputationReporter';
import { ACTP_FEEDBACK_TAGS } from '../types/erc8004';
import { ethers, Signer } from 'ethers';

// ============================================================================
// Mock Setup
// ============================================================================

/**
 * Create a mock reputation registry for testing.
 */
function createMockRegistry(): jest.Mocked<IERC8004ReputationRegistry> {
  return {
    giveFeedback: jest.fn(),
    getSummary: jest.fn(),
    revokeLatest: jest.fn(),
  };
}

/**
 * Create a mock signer for testing.
 */
function createMockSigner(): Signer {
  return {
    getAddress: jest.fn().mockResolvedValue('0xRequester1234567890123456789012345678'),
  } as unknown as Signer;
}

// ============================================================================
// Tests
// ============================================================================

describe('ReputationReporter', () => {
  let mockRegistry: jest.Mocked<IERC8004ReputationRegistry>;
  let mockSigner: Signer;
  let reporter: ReputationReporter;

  beforeEach(() => {
    mockRegistry = createMockRegistry();
    mockSigner = createMockSigner();

    reporter = new ReputationReporter({
      network: 'base-sepolia',
      signer: mockSigner,
      registryAddress: '0x1234567890123456789012345678901234567890',
      _testContract: mockRegistry,
    });
  });

  describe('reportSettlement()', () => {
    it('calls giveFeedback with correct params', async () => {
      mockRegistry.giveFeedback.mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xTxHash123',
          blockNumber: 1000,
          gasUsed: 50000n,
        }),
      });

      const result = await reporter.reportSettlement({
        agentId: '12345',
        txId: '0xACTPTransaction123',
        capability: 'code_generation',
      });

      expect(result).not.toBeNull();
      expect(result?.txHash).toBe('0xTxHash123');

      // Check giveFeedback was called with correct args
      expect(mockRegistry.giveFeedback).toHaveBeenCalledWith(
        '12345', // agentId
        1, // value (success)
        0, // decimals
        ACTP_FEEDBACK_TAGS.SETTLED, // tag1
        'code_generation', // tag2 (capability)
        '', // endpoint
        '', // feedbackURI
        expect.any(String), // feedbackHash (keccak256 of txId)
        expect.any(Object) // txOptions
      );
    });

    it('uses value=1, decimals=0 for success', async () => {
      mockRegistry.giveFeedback.mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xTxHash',
          blockNumber: 1000,
          gasUsed: 50000n,
        }),
      });

      await reporter.reportSettlement({
        agentId: '12345',
        txId: '0xTx1',
      });

      const callArgs = mockRegistry.giveFeedback.mock.calls[0];
      expect(callArgs[1]).toBe(1); // value
      expect(callArgs[2]).toBe(0); // decimals
    });

    it('uses keccak256(txId) as feedbackHash', async () => {
      mockRegistry.giveFeedback.mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xTxHash',
          blockNumber: 1000,
          gasUsed: 50000n,
        }),
      });

      const txId = '0xMyTransaction123';
      await reporter.reportSettlement({
        agentId: '12345',
        txId,
      });

      const callArgs = mockRegistry.giveFeedback.mock.calls[0];
      const expectedHash = ethers.keccak256(ethers.toUtf8Bytes(txId));
      expect(callArgs[7]).toBe(expectedHash);
    });

    it('returns ReportResult on success', async () => {
      mockRegistry.giveFeedback.mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xTxHash456',
          blockNumber: 2000,
          gasUsed: 60000n,
        }),
      });

      const result = await reporter.reportSettlement({
        agentId: '12345',
        txId: '0xTx2',
      });

      expect(result).toEqual({
        txHash: '0xTxHash456',
        blockNumber: 2000,
        gasUsed: 60000n,
      });
    });

    it('returns null on failure (does not throw)', async () => {
      mockRegistry.giveFeedback.mockRejectedValue(new Error('Transaction failed'));

      // Should NOT throw
      const result = await reporter.reportSettlement({
        agentId: '12345',
        txId: '0xFailedTx',
      });

      expect(result).toBeNull();
    });

    it('prevents duplicate reports for same txId', async () => {
      mockRegistry.giveFeedback.mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xTxHash',
          blockNumber: 1000,
          gasUsed: 50000n,
        }),
      });

      const txId = '0xDuplicateTx';

      // First call - should succeed
      const result1 = await reporter.reportSettlement({
        agentId: '12345',
        txId,
      });
      expect(result1).not.toBeNull();

      // Second call - should return null (duplicate)
      const result2 = await reporter.reportSettlement({
        agentId: '12345',
        txId,
      });
      expect(result2).toBeNull();

      // giveFeedback should only be called once
      expect(mockRegistry.giveFeedback).toHaveBeenCalledTimes(1);
    });
  });

  describe('reportDispute()', () => {
    it('reports value=1 when agent wins', async () => {
      mockRegistry.giveFeedback.mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xTxHash',
          blockNumber: 1000,
          gasUsed: 50000n,
        }),
      });

      await reporter.reportDispute({
        agentId: '12345',
        txId: '0xDisputeTx1',
        agentWon: true,
      });

      const callArgs = mockRegistry.giveFeedback.mock.calls[0];
      expect(callArgs[1]).toBe(1); // value = 1 (agent won)
      expect(callArgs[3]).toBe(ACTP_FEEDBACK_TAGS.DISPUTE_WON);
    });

    it('reports value=-1 when requester wins', async () => {
      mockRegistry.giveFeedback.mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xTxHash',
          blockNumber: 1000,
          gasUsed: 50000n,
        }),
      });

      await reporter.reportDispute({
        agentId: '12345',
        txId: '0xDisputeTx2',
        agentWon: false,
      });

      const callArgs = mockRegistry.giveFeedback.mock.calls[0];
      expect(callArgs[1]).toBe(-1); // value = -1 (agent lost)
      expect(callArgs[3]).toBe(ACTP_FEEDBACK_TAGS.DISPUTE_LOST);
    });

    it('uses correct tag1 for outcome', async () => {
      mockRegistry.giveFeedback.mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xTxHash',
          blockNumber: 1000,
          gasUsed: 50000n,
        }),
      });

      // Agent wins
      await reporter.reportDispute({
        agentId: '12345',
        txId: '0xDispute1',
        agentWon: true,
      });
      expect(mockRegistry.giveFeedback.mock.calls[0][3]).toBe('actp_dispute_won');

      // Requester wins (new reporter to avoid dedup)
      const reporter2 = new ReputationReporter({
        network: 'base-sepolia',
        signer: mockSigner,
        _testContract: mockRegistry,
      });
      await reporter2.reportDispute({
        agentId: '12345',
        txId: '0xDispute2',
        agentWon: false,
      });
      expect(mockRegistry.giveFeedback.mock.calls[1][3]).toBe('actp_dispute_lost');
    });

    it('returns null on failure', async () => {
      mockRegistry.giveFeedback.mockRejectedValue(new Error('Dispute report failed'));

      const result = await reporter.reportDispute({
        agentId: '12345',
        txId: '0xFailedDispute',
        agentWon: true,
      });

      expect(result).toBeNull();
    });
  });

  describe('getAgentReputation()', () => {
    it('returns reputation summary', async () => {
      mockRegistry.getSummary.mockResolvedValue([100n, 50n, 0]);

      const summary = await reporter.getAgentReputation('12345');

      expect(summary).toEqual({
        count: 100,
        score: 50,
      });
    });

    it('filters by tag1 if provided', async () => {
      mockRegistry.getSummary.mockResolvedValue([50n, 25n, 0]);

      await reporter.getAgentReputation('12345', 'actp_settled');

      expect(mockRegistry.getSummary).toHaveBeenCalledWith(
        '12345',
        [],
        'actp_settled',
        ''
      );
    });

    it('returns null on error', async () => {
      mockRegistry.getSummary.mockRejectedValue(new Error('Query failed'));

      const summary = await reporter.getAgentReputation('99999');

      expect(summary).toBeNull();
    });
  });

  describe('isReported()', () => {
    it('returns false for unreported txId', () => {
      expect(reporter.isReported('0xNewTx')).toBe(false);
    });

    it('returns true for reported txId', async () => {
      mockRegistry.giveFeedback.mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xTxHash',
          blockNumber: 1000,
          gasUsed: 50000n,
        }),
      });

      const txId = '0xReportedTx';
      await reporter.reportSettlement({ agentId: '12345', txId });

      expect(reporter.isReported(txId)).toBe(true);
    });
  });

  describe('clearReportedCache()', () => {
    it('clears local dedup cache', async () => {
      mockRegistry.giveFeedback.mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xTxHash',
          blockNumber: 1000,
          gasUsed: 50000n,
        }),
      });

      const txId = '0xClearedTx';

      // Report once
      await reporter.reportSettlement({ agentId: '12345', txId });
      expect(reporter.isReported(txId)).toBe(true);

      // Clear cache
      reporter.clearReportedCache();
      expect(reporter.isReported(txId)).toBe(false);

      // Can report again (locally - on-chain would still have dedup)
      const result = await reporter.reportSettlement({ agentId: '12345', txId });
      expect(result).not.toBeNull();
    });
  });

  describe('error handling', () => {
    it('logs but does not throw on insufficient funds', async () => {
      mockRegistry.giveFeedback.mockRejectedValue(new Error('insufficient funds for gas'));

      // Should not throw
      const result = await reporter.reportSettlement({
        agentId: '12345',
        txId: '0xInsufficientFunds',
      });

      expect(result).toBeNull();
    });

    it('logs but does not throw on agent owner error', async () => {
      mockRegistry.giveFeedback.mockRejectedValue(
        new Error('cannot be the agent owner')
      );

      // Should not throw
      const result = await reporter.reportSettlement({
        agentId: '12345',
        txId: '0xOwnerError',
      });

      expect(result).toBeNull();
    });
  });
});
