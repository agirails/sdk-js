/**
 * X402Adapter Unit Tests
 *
 * Tests the X402 atomic payment protocol adapter:
 * - canHandle() - HTTPS URL detection
 * - validate() - Security validations
 * - pay() - Atomic payment flow
 * - Lifecycle methods throw (atomic = no lifecycle)
 *
 * @module adapters/X402Adapter.test
 */

import {
  X402Adapter,
  X402AdapterConfig,
  TransferFunction,
  ApproveFunction,
  RelayPayFunction,
} from './X402Adapter';
import { ValidationError } from './BaseAdapter';
import {
  X402ErrorCode,
  X402_HEADERS,
  X402_PROOF_HEADERS,
} from '../types/x402';

// ============================================================================
// Mock Helpers
// ============================================================================

function mockResponse(
  status: number,
  headers: Record<string, string> = {},
  body: string = ''
): Response {
  return {
    status,
    statusText: status === 200 ? 'OK' : status === 402 ? 'Payment Required' : 'Error',
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    json: async () => JSON.parse(body || '{}'),
    text: async () => body,
    clone: function() { return this; },
    redirected: false,
    type: 'basic' as ResponseType,
    url: '',
  } as Response;
}

function mock402Response(
  paymentAddress: string,
  amount: string,
  network: string = 'base-sepolia',
  deadline: number = Math.floor(Date.now() / 1000) + 86400
): Response {
  return mockResponse(402, {
    [X402_HEADERS.REQUIRED]: 'true',
    [X402_HEADERS.ADDRESS]: paymentAddress,
    [X402_HEADERS.AMOUNT]: amount,
    [X402_HEADERS.NETWORK]: network,
    [X402_HEADERS.TOKEN]: 'USDC',
    [X402_HEADERS.DEADLINE]: deadline.toString(),
  });
}

function createMockFetch(responses: Response[]): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  let callIndex = 0;
  return async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const response = responses[callIndex] || responses[responses.length - 1];
    callIndex++;
    return response;
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('X402Adapter', () => {
  const requesterAddress = '0x1111111111111111111111111111111111111111';
  const providerAddress = '0x2222222222222222222222222222222222222222';

  // Mock transfer function - simulates atomic USDC transfer
  const mockTransferFn: TransferFunction = async (_to: string, _amount: string) => {
    return '0x' + 'a'.repeat(64); // Return mock tx hash
  };

  const defaultConfig: X402AdapterConfig = {
    expectedNetwork: 'base-sepolia',
    transferFn: mockTransferFn,
    requestTimeout: 5000,
  };

  let adapter: X402Adapter;

  beforeEach(() => {
    adapter = new X402Adapter(requesterAddress, defaultConfig);
  });

  describe('metadata', () => {
    it('has correct adapter id', () => {
      expect(adapter.metadata.id).toBe('x402');
    });

    it('does NOT use escrow (atomic!)', () => {
      expect(adapter.metadata.usesEscrow).toBe(false);
    });

    it('does NOT support disputes (atomic!)', () => {
      expect(adapter.metadata.supportsDisputes).toBe(false);
    });

    it('has atomic settlement mode', () => {
      expect(adapter.metadata.settlementMode).toBe('atomic');
    });

    it('has priority 70', () => {
      expect(adapter.metadata.priority).toBe(70);
    });
  });

  describe('canHandle()', () => {
    it('returns true for HTTPS URLs', () => {
      expect(adapter.canHandle({ to: 'https://api.example.com/service', amount: '10' })).toBe(true);
      expect(adapter.canHandle({ to: 'https://localhost:3000/pay', amount: '10' })).toBe(true);
    });

    it('returns false for HTTP URLs (security)', () => {
      expect(adapter.canHandle({ to: 'http://api.example.com/service', amount: '10' })).toBe(false);
    });

    it('returns false for Ethereum addresses', () => {
      expect(adapter.canHandle({ to: '0x1234567890123456789012345678901234567890', amount: '10' })).toBe(false);
    });

    it('returns false for invalid URLs', () => {
      expect(adapter.canHandle({ to: 'not-a-url', amount: '10' })).toBe(false);
    });
  });

  describe('validate()', () => {
    it('passes for valid HTTPS URL', () => {
      expect(() => adapter.validate({
        to: 'https://api.example.com/service',
        amount: '10',
      })).not.toThrow();
    });

    it('throws for HTTP URL', () => {
      expect(() => adapter.validate({
        to: 'http://api.example.com/service',
        amount: '10',
      })).toThrow(ValidationError);
    });

    it('throws for URL with embedded credentials', () => {
      expect(() => adapter.validate({
        to: 'https://user:pass@api.example.com/service',
        amount: '10',
      })).toThrow(/embedded credentials/);
    });
  });

  describe('pay() - atomic flow', () => {
    it('handles happy path: 402 → atomic payment → 200', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
        mockResponse(200, {}, '{"data": "success"}'),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      const result = await adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      expect(result.success).toBe(true);
      expect(result.txId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(result.adapter).toBe('x402');
    });

    it('escrowId is null (no escrow!)', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
        mockResponse(200),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      const result = await adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      expect(result.escrowId).toBeNull();
    });

    it('releaseRequired is false (atomic = instant settlement)', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
        mockResponse(200),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      const result = await adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      expect(result.releaseRequired).toBe(false);
    });

    it('returns response in result', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
        mockResponse(200),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      const result = await adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      expect(result.response).toBeDefined();
      expect(result.response?.status).toBe(200);
    });

    it('calls transferFn with correct params', async () => {
      let capturedTo: string | undefined;
      let capturedAmount: string | undefined;

      const trackingTransfer: TransferFunction = async (to, amount) => {
        capturedTo = to;
        capturedAmount = amount;
        return '0x' + 'b'.repeat(64);
      };

      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
        mockResponse(200),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        transferFn: trackingTransfer,
        fetchFn: mockFetch,
      });

      await adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      expect(capturedTo).toBe(providerAddress.toLowerCase());
      expect(capturedAmount).toBe('10000000');
    });

    it('handles free service (200 on initial request)', async () => {
      const mockFetch = createMockFetch([
        mockResponse(200, {}, '{"free": true}'),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      const result = await adapterWithMock.pay({
        to: 'https://api.example.com/free',
        amount: '10',
      });

      expect(result.success).toBe(true);
      expect(result.amount).toBe('0.00 USDC');
      expect(result.releaseRequired).toBe(false);
    });

    it('throws for network mismatch', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000', 'base-mainnet'), // Wrong network
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      await expect(adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      })).rejects.toMatchObject({
        code: X402ErrorCode.NETWORK_MISMATCH,
      });
    });

    it('throws for retry failure', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
        mockResponse(500),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      await expect(adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      })).rejects.toMatchObject({
        code: X402ErrorCode.RETRY_FAILED,
      });
    });

    it('throws for payment failure', async () => {
      const failingTransfer: TransferFunction = async () => {
        throw new Error('Insufficient balance');
      };

      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        transferFn: failingTransfer,
        fetchFn: mockFetch,
      });

      await expect(adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      })).rejects.toMatchObject({
        code: X402ErrorCode.PAYMENT_FAILED,
      });
    });
  });

  describe('parsePaymentHeaders()', () => {
    it('throws for missing X-Payment-Required', async () => {
      const mockFetch = createMockFetch([
        mockResponse(402, {
          [X402_HEADERS.ADDRESS]: providerAddress,
          [X402_HEADERS.AMOUNT]: '10000000',
          [X402_HEADERS.NETWORK]: 'base-sepolia',
          [X402_HEADERS.TOKEN]: 'USDC',
          [X402_HEADERS.DEADLINE]: (Date.now() / 1000 + 86400).toString(),
        }),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      await expect(adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      })).rejects.toMatchObject({
        code: X402ErrorCode.MISSING_HEADERS,
      });
    });

    it('throws for invalid address', async () => {
      const mockFetch = createMockFetch([
        mockResponse(402, {
          [X402_HEADERS.REQUIRED]: 'true',
          [X402_HEADERS.ADDRESS]: 'invalid',
          [X402_HEADERS.AMOUNT]: '10000000',
          [X402_HEADERS.NETWORK]: 'base-sepolia',
          [X402_HEADERS.TOKEN]: 'USDC',
          [X402_HEADERS.DEADLINE]: (Date.now() / 1000 + 86400).toString(),
        }),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      await expect(adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      })).rejects.toMatchObject({
        code: X402ErrorCode.INVALID_ADDRESS,
      });
    });

    it('throws for invalid network', async () => {
      const mockFetch = createMockFetch([
        mockResponse(402, {
          [X402_HEADERS.REQUIRED]: 'true',
          [X402_HEADERS.ADDRESS]: providerAddress,
          [X402_HEADERS.AMOUNT]: '10000000',
          [X402_HEADERS.NETWORK]: 'ethereum-mainnet',
          [X402_HEADERS.TOKEN]: 'USDC',
          [X402_HEADERS.DEADLINE]: (Date.now() / 1000 + 86400).toString(),
        }),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      await expect(adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      })).rejects.toMatchObject({
        code: X402ErrorCode.INVALID_NETWORK,
      });
    });
  });

  describe('lifecycle methods throw (atomic = no lifecycle)', () => {
    it('startWork() throws', async () => {
      await expect(adapter.startWork('0x123')).rejects.toThrow('X402 is atomic');
    });

    it('deliver() throws', async () => {
      await expect(adapter.deliver('0x123')).rejects.toThrow('X402 is atomic');
    });

    it('release() throws', async () => {
      await expect(adapter.release('0x123')).rejects.toThrow('X402 is atomic');
    });
  });

  describe('getStatus()', () => {
    it('returns SETTLED for completed payment', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
        mockResponse(200),
      ]);

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      const result = await adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      const status = await adapterWithMock.getStatus(result.txId);

      expect(status.state).toBe('SETTLED');
      expect(status.canStartWork).toBe(false);
      expect(status.canDeliver).toBe(false);
      expect(status.canRelease).toBe(false);
      expect(status.canDispute).toBe(false);
    });

    it('throws for unknown payment', async () => {
      await expect(adapter.getStatus('0x' + '9'.repeat(64))).rejects.toThrow('not found');
    });
  });

  describe('sends tx hash as proof on retry', () => {
    it('includes X-Payment-Tx-Id header', async () => {
      let capturedHeaders: Headers | undefined;
      let callCount = 0;

      const trackingFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        callCount++;
        if (callCount === 1) {
          return mock402Response(providerAddress, '10000000');
        } else {
          capturedHeaders = new Headers(init?.headers as HeadersInit);
          return mockResponse(200);
        }
      };

      const adapterWithMock = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: trackingFetch,
      });

      const result = await adapterWithMock.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders!.get(X402_PROOF_HEADERS.TX_ID)).toBe(result.txId);
      // No escrow ID for atomic payments
      expect(capturedHeaders!.get(X402_PROOF_HEADERS.ESCROW_ID)).toBeNull();
    });
  });

  // ==========================================================================
  // X402Relay Fee Splitting Tests
  // ==========================================================================

  describe('pay() - relay path (fee splitting)', () => {
    const relayAddress = '0x3333333333333333333333333333333333333333';
    const relayTxHash = '0x' + 'c'.repeat(64);

    // Tracking mocks for relay functions
    let approveSpender: string | undefined;
    let approveAmount: string | undefined;
    let relayProvider: string | undefined;
    let relayGross: string | undefined;
    let relayServiceId: string | undefined;

    const mockApproveFn: ApproveFunction = async (spender, amount) => {
      approveSpender = spender;
      approveAmount = amount;
      return '0x' + 'd'.repeat(64);
    };

    const mockRelayPayFn: RelayPayFunction = async (provider, grossAmount, serviceId) => {
      relayProvider = provider;
      relayGross = grossAmount;
      relayServiceId = serviceId;
      return relayTxHash;
    };

    const relayConfig: X402AdapterConfig = {
      expectedNetwork: 'base-sepolia',
      transferFn: mockTransferFn, // legacy fallback
      relayAddress,
      approveFn: mockApproveFn,
      relayPayFn: mockRelayPayFn,
      platformFeeBps: 100, // 1%
      requestTimeout: 5000,
    };

    beforeEach(() => {
      approveSpender = undefined;
      approveAmount = undefined;
      relayProvider = undefined;
      relayGross = undefined;
      relayServiceId = undefined;
    });

    it('uses relay path when relayAddress + approveFn + relayPayFn configured', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '100000000'), // $100
        mockResponse(200),
      ]);

      const adapterWithRelay = new X402Adapter(requesterAddress, {
        ...relayConfig,
        fetchFn: mockFetch,
      });

      const result = await adapterWithRelay.pay({
        to: 'https://api.example.com/service',
        amount: '100',
      });

      expect(result.success).toBe(true);
      expect(result.txId).toBe(relayTxHash);
    });

    it('approves relay contract for gross amount', async () => {
      const grossAmount = '100000000'; // $100
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, grossAmount),
        mockResponse(200),
      ]);

      const adapterWithRelay = new X402Adapter(requesterAddress, {
        ...relayConfig,
        fetchFn: mockFetch,
      });

      await adapterWithRelay.pay({
        to: 'https://api.example.com/service',
        amount: '100',
      });

      expect(approveSpender).toBe(relayAddress);
      expect(approveAmount).toBe(grossAmount);
    });

    it('passes provider and gross amount to relayPayFn', async () => {
      const grossAmount = '100000000'; // $100
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, grossAmount),
        mockResponse(200),
      ]);

      const adapterWithRelay = new X402Adapter(requesterAddress, {
        ...relayConfig,
        fetchFn: mockFetch,
      });

      await adapterWithRelay.pay({
        to: 'https://api.example.com/service',
        amount: '100',
      });

      expect(relayProvider).toBe(providerAddress.toLowerCase());
      expect(relayGross).toBe(grossAmount);
    });

    it('passes serviceId from 402 headers to relay', async () => {
      const svcId = 'my-service-123';
      const mockFetch = createMockFetch([
        mockResponse(402, {
          [X402_HEADERS.REQUIRED]: 'true',
          [X402_HEADERS.ADDRESS]: providerAddress,
          [X402_HEADERS.AMOUNT]: '10000000',
          [X402_HEADERS.NETWORK]: 'base-sepolia',
          [X402_HEADERS.TOKEN]: 'USDC',
          [X402_HEADERS.DEADLINE]: (Math.floor(Date.now() / 1000) + 86400).toString(),
          [X402_HEADERS.SERVICE_ID]: svcId,
        }),
        mockResponse(200),
      ]);

      const adapterWithRelay = new X402Adapter(requesterAddress, {
        ...relayConfig,
        fetchFn: mockFetch,
      });

      await adapterWithRelay.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      expect(relayServiceId).toBe(svcId);
    });

    it('uses zero-hash serviceId when header absent', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'), // no serviceId header
        mockResponse(200),
      ]);

      const adapterWithRelay = new X402Adapter(requesterAddress, {
        ...relayConfig,
        fetchFn: mockFetch,
      });

      await adapterWithRelay.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      expect(relayServiceId).toBe('0x' + '0'.repeat(64));
    });

    // -- Fee breakdown tests --

    it('returns feeBreakdown with correct 1% split for $100', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '100000000'), // $100
        mockResponse(200),
      ]);

      const adapterWithRelay = new X402Adapter(requesterAddress, {
        ...relayConfig,
        fetchFn: mockFetch,
      });

      const result = await adapterWithRelay.pay({
        to: 'https://api.example.com/service',
        amount: '100',
      });

      expect(result.feeBreakdown).toBeDefined();
      expect(result.feeBreakdown!.grossAmount).toBe('100000000');
      expect(result.feeBreakdown!.platformFee).toBe('1000000'); // $1
      expect(result.feeBreakdown!.providerNet).toBe('99000000'); // $99
      expect(result.feeBreakdown!.feeBps).toBe(100);
      expect(result.feeBreakdown!.estimated).toBe(true);
    });

    it('enforces $0.05 minimum fee for small amounts', async () => {
      // $1 payment: 1% = $0.01, but MIN_FEE = $0.05
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '1000000'), // $1
        mockResponse(200),
      ]);

      const adapterWithRelay = new X402Adapter(requesterAddress, {
        ...relayConfig,
        fetchFn: mockFetch,
      });

      const result = await adapterWithRelay.pay({
        to: 'https://api.example.com/service',
        amount: '1',
      });

      expect(result.feeBreakdown).toBeDefined();
      expect(result.feeBreakdown!.grossAmount).toBe('1000000');
      expect(result.feeBreakdown!.platformFee).toBe('50000'); // MIN_FEE = $0.05
      expect(result.feeBreakdown!.providerNet).toBe('950000'); // $0.95
    });

    it('uses 1% when it exceeds minimum ($5 threshold)', async () => {
      // $5: 1% = $0.05 = MIN_FEE (exactly at threshold, bps == MIN_FEE)
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '5000000'), // $5
        mockResponse(200),
      ]);

      const adapterWithRelay = new X402Adapter(requesterAddress, {
        ...relayConfig,
        fetchFn: mockFetch,
      });

      const result = await adapterWithRelay.pay({
        to: 'https://api.example.com/service',
        amount: '5',
      });

      // At exactly $5, bpsFee = 50000 = MIN_FEE; contract uses MIN_FEE (not strictly greater)
      expect(result.feeBreakdown!.platformFee).toBe('50000');
    });

    it('uses custom platformFeeBps when provided', async () => {
      // 2% fee on $100 = $2
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '100000000'),
        mockResponse(200),
      ]);

      const adapterWith2Pct = new X402Adapter(requesterAddress, {
        ...relayConfig,
        platformFeeBps: 200, // 2%
        fetchFn: mockFetch,
      });

      const result = await adapterWith2Pct.pay({
        to: 'https://api.example.com/service',
        amount: '100',
      });

      expect(result.feeBreakdown!.platformFee).toBe('2000000'); // $2
      expect(result.feeBreakdown!.providerNet).toBe('98000000'); // $98
      expect(result.feeBreakdown!.feeBps).toBe(200);
    });

    it('defaults platformFeeBps to 100 (1%) when not specified', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '100000000'),
        mockResponse(200),
      ]);

      const { platformFeeBps: _platformFeeBps, ...configWithoutBps } = relayConfig;
      const adapterNoBps = new X402Adapter(requesterAddress, {
        ...configWithoutBps,
        fetchFn: mockFetch,
      });

      const result = await adapterNoBps.pay({
        to: 'https://api.example.com/service',
        amount: '100',
      });

      expect(result.feeBreakdown!.feeBps).toBe(100);
      expect(result.feeBreakdown!.platformFee).toBe('1000000');
    });

    it('feeBreakdown.estimated is always true', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
        mockResponse(200),
      ]);

      const adapterWithRelay = new X402Adapter(requesterAddress, {
        ...relayConfig,
        fetchFn: mockFetch,
      });

      const result = await adapterWithRelay.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      expect(result.feeBreakdown!.estimated).toBe(true);
    });

    // -- Fallback / error tests --

    it('falls back to legacy (no feeBreakdown) without relay config', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
        mockResponse(200),
      ]);

      const legacyAdapter = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        fetchFn: mockFetch,
      });

      const result = await legacyAdapter.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      expect(result.feeBreakdown).toBeUndefined();
      expect(result.success).toBe(true);
    });

    it('falls back to legacy when only relayAddress set (missing approveFn)', async () => {
      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
        mockResponse(200),
      ]);

      const partialConfig = new X402Adapter(requesterAddress, {
        ...defaultConfig,
        relayAddress,
        // no approveFn, no relayPayFn
        fetchFn: mockFetch,
      });

      const result = await partialConfig.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      });

      expect(result.feeBreakdown).toBeUndefined();
    });

    it('throws PAYMENT_FAILED when approveFn fails', async () => {
      const failingApprove: ApproveFunction = async () => {
        throw new Error('Approve rejected');
      };

      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
      ]);

      const adapterFailApprove = new X402Adapter(requesterAddress, {
        ...relayConfig,
        approveFn: failingApprove,
        fetchFn: mockFetch,
      });

      await expect(adapterFailApprove.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      })).rejects.toMatchObject({
        code: X402ErrorCode.PAYMENT_FAILED,
      });
    });

    it('throws PAYMENT_FAILED when relayPayFn fails', async () => {
      const failingRelay: RelayPayFunction = async () => {
        throw new Error('Relay tx reverted');
      };

      const mockFetch = createMockFetch([
        mock402Response(providerAddress, '10000000'),
      ]);

      const adapterFailRelay = new X402Adapter(requesterAddress, {
        ...relayConfig,
        relayPayFn: failingRelay,
        fetchFn: mockFetch,
      });

      await expect(adapterFailRelay.pay({
        to: 'https://api.example.com/service',
        amount: '10',
      })).rejects.toMatchObject({
        code: X402ErrorCode.PAYMENT_FAILED,
      });
    });
  });
});
