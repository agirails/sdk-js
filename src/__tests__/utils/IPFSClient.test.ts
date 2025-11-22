/**
 * IPFSClient Test Suite
 *
 * Coverage Target: 80%+ (statements, functions, lines, branches)
 *
 * Test Categories:
 * 1. Upload Operations (3 tests)
 * 2. Pin Operations (2 tests)
 * 3. Retrieval Operations (2 tests)
 * 4. Connection Tests (2 tests)
 * 5. Factory Function (1 test)
 *
 * References:
 * - IPFSClient.ts implementation
 * - ipfs-http-client library
 */

// Mock ipfs-http-client before importing IPFSClient
const mockIPFSClient = {
  add: jest.fn(),
  pin: {
    add: jest.fn()
  },
  cat: jest.fn(),
  id: jest.fn()
};

const mockCreate = jest.fn(() => mockIPFSClient);

jest.mock('ipfs-http-client', () => ({
  create: mockCreate
}), { virtual: true });

import { IPFSHTTPClientImpl, createIPFSClient } from '../../utils/IPFSClient';

describe('IPFSClient - Upload Operations', () => {
  let ipfsClient: IPFSHTTPClientImpl;

  beforeEach(() => {
    jest.clearAllMocks();
    ipfsClient = new IPFSHTTPClientImpl({ url: 'http://localhost:5001' });
  });

  it('should upload string data successfully', async () => {
    const testData = JSON.stringify({ result: 'success', output: 'test' });
    const mockCID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

    mockIPFSClient.add.mockResolvedValue({
      cid: {
        toString: () => mockCID
      }
    });

    const result = await ipfsClient.add(testData);

    expect(mockIPFSClient.add).toHaveBeenCalledWith(
      Buffer.from(testData, 'utf-8'),
      expect.objectContaining({
        cidVersion: 1,
        hashAlg: 'sha2-256',
        pin: true
      })
    );

    expect(result).toBe(mockCID);
  });

  it('should upload buffer data successfully', async () => {
    const testBuffer = Buffer.from('test binary data');
    const mockCID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

    mockIPFSClient.add.mockResolvedValue({
      cid: {
        toString: () => mockCID
      }
    });

    const result = await ipfsClient.add(testBuffer);

    expect(mockIPFSClient.add).toHaveBeenCalledWith(
      testBuffer,
      expect.objectContaining({
        cidVersion: 1,
        hashAlg: 'sha2-256',
        pin: true
      })
    );

    expect(result).toBe(mockCID);
  });

  it('should handle upload errors', async () => {
    const testData = 'test data';

    mockIPFSClient.add.mockRejectedValue(new Error('Network timeout'));

    await expect(ipfsClient.add(testData)).rejects.toThrow('IPFS upload failed: Network timeout');
  });
});

describe('IPFSClient - Pin Operations', () => {
  let ipfsClient: IPFSHTTPClientImpl;

  beforeEach(() => {
    jest.clearAllMocks();
    ipfsClient = new IPFSHTTPClientImpl({ url: 'http://localhost:5001' });
  });

  it('should pin content successfully', async () => {
    const testCID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

    mockIPFSClient.pin.add.mockResolvedValue(undefined);

    await ipfsClient.pin(testCID);

    expect(mockIPFSClient.pin.add).toHaveBeenCalledWith(testCID);
  });

  it('should handle pin errors', async () => {
    const testCID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

    mockIPFSClient.pin.add.mockRejectedValue(new Error('Pin quota exceeded'));

    await expect(ipfsClient.pin(testCID)).rejects.toThrow('IPFS pin failed: Pin quota exceeded');
  });
});

describe('IPFSClient - Retrieval Operations', () => {
  let ipfsClient: IPFSHTTPClientImpl;

  beforeEach(() => {
    jest.clearAllMocks();
    ipfsClient = new IPFSHTTPClientImpl({ url: 'http://localhost:5001' });
  });

  it('should retrieve content successfully', async () => {
    const testCID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    const testContent = JSON.stringify({ result: 'success' });

    // Mock async iterator
    async function* mockAsyncIterator() {
      yield new Uint8Array(Buffer.from(testContent));
    }

    mockIPFSClient.cat.mockReturnValue(mockAsyncIterator());

    const result = await ipfsClient.get(testCID);

    expect(mockIPFSClient.cat).toHaveBeenCalledWith(testCID);
    expect(result).toBe(testContent);
  });

  it('should handle retrieval errors', async () => {
    const testCID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

    // Mock async iterator that throws
    async function* mockErrorIterator() {
      throw new Error('Content not found');
    }

    mockIPFSClient.cat.mockReturnValue(mockErrorIterator());

    await expect(ipfsClient.get(testCID)).rejects.toThrow('IPFS retrieval failed: Content not found');
  });

  it('should concatenate multiple chunks correctly', async () => {
    const testCID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    const chunk1 = 'Hello ';
    const chunk2 = 'World!';

    // Mock async iterator with multiple chunks
    async function* mockChunkedIterator() {
      yield new Uint8Array(Buffer.from(chunk1));
      yield new Uint8Array(Buffer.from(chunk2));
    }

    mockIPFSClient.cat.mockReturnValue(mockChunkedIterator());

    const result = await ipfsClient.get(testCID);

    expect(result).toBe('Hello World!');
  });
});

describe('IPFSClient - Connection Tests', () => {
  let ipfsClient: IPFSHTTPClientImpl;

  beforeEach(() => {
    jest.clearAllMocks();
    ipfsClient = new IPFSHTTPClientImpl({ url: 'http://localhost:5001' });
  });

  it('should check if daemon is online', async () => {
    mockIPFSClient.id.mockResolvedValue({
      id: 'QmTestNodeId123',
      publicKey: 'mockPublicKey'
    });

    const isOnline = await ipfsClient.isOnline();

    expect(isOnline).toBe(true);
    expect(mockIPFSClient.id).toHaveBeenCalled();
  });

  it('should return false when daemon is offline', async () => {
    mockIPFSClient.id.mockRejectedValue(new Error('Connection refused'));

    const isOnline = await ipfsClient.isOnline();

    expect(isOnline).toBe(false);
  });

  it('should get node ID successfully', async () => {
    const mockNodeId = 'QmTestNodeId123456789';

    mockIPFSClient.id.mockResolvedValue({
      id: {
        toString: () => mockNodeId
      }
    });

    const nodeId = await ipfsClient.getNodeId();

    expect(nodeId).toBe(mockNodeId);
  });

  it('should handle get node ID errors', async () => {
    mockIPFSClient.id.mockRejectedValue(new Error('Daemon not running'));

    await expect(ipfsClient.getNodeId()).rejects.toThrow('Failed to get node ID: Daemon not running');
  });
});

describe('IPFSClient - Factory Function', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear environment variables
    delete process.env.INFURA_PROJECT_ID;
    delete process.env.INFURA_PROJECT_SECRET;
    delete process.env.PINATA_API_KEY;
    delete process.env.PINATA_SECRET_API_KEY;
    delete process.env.IPFS_URL;
  });

  it('should create client with default config', () => {
    const client = createIPFSClient();

    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(IPFSHTTPClientImpl);
  });

  it('should create client with custom IPFS_URL', () => {
    process.env.IPFS_URL = 'https://custom-ipfs.example.com';

    const client = createIPFSClient();

    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(IPFSHTTPClientImpl);
  });
});
