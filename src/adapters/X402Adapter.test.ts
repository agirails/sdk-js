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

import { X402Adapter, X402AdapterConfig, TransferFunction } from './X402Adapter';
import { ValidationError } from './BaseAdapter';
import {
  X402Error,
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
});
