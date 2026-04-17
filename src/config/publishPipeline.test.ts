/**
 * Publish Pipeline Tests
 *
 * Tests the publish flow with mocked storage clients and registry.
 * Tests extractRegistrationParams, validation helpers, and the
 * full publishAgirailsMd orchestration.
 *
 * @module config/publishPipeline.test
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import { publishAgirailsMd, PENDING_ENDPOINT, extractRegistrationParams } from './publishPipeline';
import * as fs from 'fs';

// ============================================================================
// Mocks
// ============================================================================

jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;
const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>;

// Mock FilebaseClient
function createMockFilebaseClient(cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi') {
  return {
    uploadBinary: jest.fn().mockResolvedValue({ cid }),
    uploadJSON: jest.fn().mockResolvedValue({ cid }),
  };
}

// Mock ArweaveClient
function createMockArweaveClient(txId = 'arweave-tx-id-43-chars-base64url-padded00') {
  return {
    uploadJSON: jest.fn().mockResolvedValue({ txId }),
  };
}

// Mock AgentRegistry (protocol/)
jest.mock('../protocol/AgentRegistry', () => ({
  AgentRegistry: jest.fn().mockImplementation(() => ({
    getAgent: jest.fn().mockResolvedValue({ endpoint: 'https://test.com' }),
    registerAgent: jest.fn().mockResolvedValue({ txHash: '0xreg' }),
  })),
}));

// Mock AgentRegistryClient (registry/)
jest.mock('../registry/AgentRegistryClient', () => ({
  AgentRegistryClient: jest.fn().mockImplementation(() => ({
    publishConfig: jest.fn().mockResolvedValue({ txHash: '0xpub123' }),
  })),
}));

// Mock Signer
function createMockSigner(address = '0x1234567890abcdef1234567890abcdef12345678') {
  return {
    getAddress: jest.fn().mockResolvedValue(address),
    provider: {},
  } as any;
}

// ============================================================================
// Test fixtures
// ============================================================================

const SAMPLE_MD = `---
name: test-agent
version: "1.0.0"
capabilities:
  - text-generation
---
# Test Agent

Does stuff.
`;

const SAMPLE_MD_WITH_SERVICES = `---
name: test-agent
version: "1.0.0"
endpoint: "https://my-agent.com/webhook"
services:
  - type: text-generation
    price: "1.0-100.0"
    schema_uri: "https://schema.org/text"
  - type: code-review
    min_price: 5.0
    max_price: 50.0
---
# Test Agent
`;

const SAMPLE_MD_NO_CAPABILITIES = `---
name: test-agent
version: "1.0.0"
---
# Test Agent
`;

// ============================================================================
// extractRegistrationParams (tested indirectly via publishAgirailsMd)
// ============================================================================

describe('publishAgirailsMd', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFileSync.mockReturnValue(SAMPLE_MD);
    mockWriteFileSync.mockImplementation(() => {});
  });

  test('dry run returns hash without side effects', async () => {
    const result = await publishAgirailsMd({
      path: '/test/AGIRAILS.md',
      network: 'base-sepolia',
      registryAddress: '0xreg',
      signer: createMockSigner(),
      filebaseClient: createMockFilebaseClient() as any,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.cid).toBe('(dry-run)');
    expect(result.configHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(result.registered).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  test('full publish: uploads to IPFS + on-chain', async () => {
    const mockFilebase = createMockFilebaseClient();
    const mockSigner = createMockSigner();

    const result = await publishAgirailsMd({
      path: '/test/AGIRAILS.md',
      network: 'base-sepolia',
      registryAddress: '0xreg',
      signer: mockSigner,
      filebaseClient: mockFilebase as any,
      skipArweave: true,
    });

    expect(result.dryRun).toBe(false);
    expect(result.cid).toBe('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    expect(result.txHash).toBe('0xpub123');
    expect(result.configHash).toMatch(/^0x[a-f0-9]{64}$/);

    // Filebase upload called with raw binary
    expect(mockFilebase.uploadBinary).toHaveBeenCalledWith(
      expect.any(Buffer),
      'text/markdown',
      expect.any(Object)
    );
  });

  test('full publish with Arweave', async () => {
    const mockFilebase = createMockFilebaseClient();
    const mockArweave = createMockArweaveClient();

    const result = await publishAgirailsMd({
      path: '/test/AGIRAILS.md',
      network: 'base-sepolia',
      registryAddress: '0xreg',
      signer: createMockSigner(),
      filebaseClient: mockFilebase as any,
      arweaveClient: mockArweave as any,
      skipArweave: false,
    });

    expect(result.arweaveTxId).toBe('arweave-tx-id-43-chars-base64url-padded00');
    expect(mockArweave.uploadJSON).toHaveBeenCalledWith(
      expect.objectContaining({ _format: 'agirails.md.v1' }),
      expect.arrayContaining([
        expect.objectContaining({ name: 'Type', value: 'agent-config' }),
        expect.objectContaining({ name: 'ConfigHash' }),
        expect.objectContaining({ name: 'IPFS-CID' }),
      ])
    );
  });

  test('updates frontmatter after publish', async () => {
    await publishAgirailsMd({
      path: '/test/AGIRAILS.md',
      network: 'base-sepolia',
      registryAddress: '0xreg',
      signer: createMockSigner(),
      filebaseClient: createMockFilebaseClient() as any,
      skipArweave: true,
    });

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('config_hash:');
    expect(writtenContent).toContain('published_at:');
    expect(writtenContent).toContain('config_cid:');
  });

  test('auto-registers unregistered agent', async () => {
    // Override AgentRegistry mock to return null (not registered)
    const { AgentRegistry } = require('../protocol/AgentRegistry');
    AgentRegistry.mockImplementation(() => ({
      getAgent: jest.fn().mockResolvedValue(null),
      registerAgent: jest.fn().mockResolvedValue({ txHash: '0xreg' }),
    }));

    const result = await publishAgirailsMd({
      path: '/test/AGIRAILS.md',
      network: 'base-sepolia',
      registryAddress: '0xreg',
      signer: createMockSigner(),
      filebaseClient: createMockFilebaseClient() as any,
      skipArweave: true,
    });

    expect(result.registered).toBe(true);
  });

  test('does not auto-register already registered agent', async () => {
    const { AgentRegistry } = require('../protocol/AgentRegistry');
    const mockRegisterAgent = jest.fn();
    AgentRegistry.mockImplementation(() => ({
      getAgent: jest.fn().mockResolvedValue({ endpoint: 'https://existing.com' }),
      registerAgent: mockRegisterAgent,
    }));

    const result = await publishAgirailsMd({
      path: '/test/AGIRAILS.md',
      network: 'base-sepolia',
      registryAddress: '0xreg',
      signer: createMockSigner(),
      filebaseClient: createMockFilebaseClient() as any,
      skipArweave: true,
    });

    expect(result.registered).toBe(false);
    expect(mockRegisterAgent).not.toHaveBeenCalled();
  });
});

// ============================================================================
// extractRegistrationParams (tested through module internals)
// We test the behavior indirectly via parseAgirailsMd + the publish flow,
// and directly for the exported helpers we can access.
// ============================================================================

describe('registration param extraction (via publish)', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Override to not-registered so extractRegistrationParams runs
    const { AgentRegistry } = require('../protocol/AgentRegistry');
    AgentRegistry.mockImplementation(() => ({
      getAgent: jest.fn().mockResolvedValue(null),
      registerAgent: jest.fn().mockResolvedValue({ txHash: '0xreg' }),
    }));
  });

  test('capabilities → services with defaults', async () => {
    mockReadFileSync.mockReturnValue(SAMPLE_MD);
    mockWriteFileSync.mockImplementation(() => {});

    const { AgentRegistry } = require('../protocol/AgentRegistry');
    const mockRegisterAgent = jest.fn().mockResolvedValue({ txHash: '0xreg' });
    AgentRegistry.mockImplementation(() => ({
      getAgent: jest.fn().mockResolvedValue(null),
      registerAgent: mockRegisterAgent,
    }));

    await publishAgirailsMd({
      path: '/test/AGIRAILS.md',
      network: 'base-sepolia',
      registryAddress: '0xreg',
      signer: createMockSigner(),
      filebaseClient: createMockFilebaseClient() as any,
      skipArweave: true,
    });

    expect(mockRegisterAgent).toHaveBeenCalledTimes(1);
    const regParams = mockRegisterAgent.mock.calls[0][0];
    expect(regParams.endpoint).toBe(PENDING_ENDPOINT);
    expect(regParams.serviceDescriptors).toHaveLength(1);
    expect(regParams.serviceDescriptors[0].serviceType).toBe('text-generation');
    expect(regParams.serviceDescriptors[0].serviceTypeHash).toBe(
      keccak256(toUtf8Bytes('text-generation'))
    );
  });

  test('services with pricing → ServiceDescriptor', async () => {
    mockReadFileSync.mockReturnValue(SAMPLE_MD_WITH_SERVICES);
    mockWriteFileSync.mockImplementation(() => {});

    const { AgentRegistry } = require('../protocol/AgentRegistry');
    const mockRegisterAgent = jest.fn().mockResolvedValue({ txHash: '0xreg' });
    AgentRegistry.mockImplementation(() => ({
      getAgent: jest.fn().mockResolvedValue(null),
      registerAgent: mockRegisterAgent,
    }));

    await publishAgirailsMd({
      path: '/test/AGIRAILS.md',
      network: 'base-sepolia',
      registryAddress: '0xreg',
      signer: createMockSigner(),
      filebaseClient: createMockFilebaseClient() as any,
      skipArweave: true,
    });

    const regParams = mockRegisterAgent.mock.calls[0][0];
    expect(regParams.endpoint).toBe('https://my-agent.com/webhook');
    expect(regParams.serviceDescriptors).toHaveLength(2);

    const textGen = regParams.serviceDescriptors[0];
    expect(textGen.serviceType).toBe('text-generation');
    expect(textGen.minPrice).toBe(BigInt(1_000_000)); // 1.0 USDC
    expect(textGen.maxPrice).toBe(BigInt(100_000_000)); // 100.0 USDC
    expect(textGen.schemaURI).toBe('https://schema.org/text');

    const codeReview = regParams.serviceDescriptors[1];
    expect(codeReview.serviceType).toBe('code-review');
    expect(codeReview.minPrice).toBe(BigInt(5_000_000)); // 5.0 USDC
    expect(codeReview.maxPrice).toBe(BigInt(50_000_000)); // 50.0 USDC
  });

  test('no capabilities or services → throws', async () => {
    mockReadFileSync.mockReturnValue(SAMPLE_MD_NO_CAPABILITIES);
    mockWriteFileSync.mockImplementation(() => {});

    await expect(
      publishAgirailsMd({
        path: '/test/AGIRAILS.md',
        network: 'base-sepolia',
        registryAddress: '0xreg',
        signer: createMockSigner(),
        filebaseClient: createMockFilebaseClient() as any,
        skipArweave: true,
      })
    ).rejects.toThrow('services');
  });
});

// ============================================================================
// PENDING_ENDPOINT
// ============================================================================

describe('PENDING_ENDPOINT', () => {
  test('is a valid URL', () => {
    expect(() => new URL(PENDING_ENDPOINT)).not.toThrow();
  });

  test('is the expected value', () => {
    expect(PENDING_ENDPOINT).toBe('https://pending.agirails.io');
  });
});

// ============================================================================
// Service type validation (tested indirectly)
// ============================================================================

describe('service type validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteFileSync.mockImplementation(() => {});

    const { AgentRegistry } = require('../protocol/AgentRegistry');
    AgentRegistry.mockImplementation(() => ({
      getAgent: jest.fn().mockResolvedValue(null),
      registerAgent: jest.fn().mockResolvedValue({ txHash: '0xreg' }),
    }));
  });

  test('rejects service types with spaces', async () => {
    const md = `---\nname: test\ncapabilities:\n  - "text generation"\n---\n# Body`;
    mockReadFileSync.mockReturnValue(md);

    await expect(
      publishAgirailsMd({
        path: '/test/AGIRAILS.md',
        network: 'base-sepolia',
        registryAddress: '0xreg',
        signer: createMockSigner(),
        filebaseClient: createMockFilebaseClient() as any,
        skipArweave: true,
      })
    ).rejects.toThrow('Invalid service type');
  });

  test('normalizes uppercase capabilities to lowercase', async () => {
    // Uppercase is auto-lowercased, not rejected
    const md = `---\nname: test\ncapabilities:\n  - TextGeneration\n---\n# Body`;
    mockReadFileSync.mockReturnValue(md);
    mockWriteFileSync.mockImplementation(() => {});

    const { AgentRegistry } = require('../protocol/AgentRegistry');
    const mockRegisterAgent = jest.fn().mockResolvedValue({ txHash: '0xreg' });
    AgentRegistry.mockImplementation(() => ({
      getAgent: jest.fn().mockResolvedValue(null),
      registerAgent: mockRegisterAgent,
    }));

    // "TextGeneration" lowercased to "textgeneration" — passes validation
    await publishAgirailsMd({
      path: '/test/AGIRAILS.md',
      network: 'base-sepolia',
      registryAddress: '0xreg',
      signer: createMockSigner(),
      filebaseClient: createMockFilebaseClient() as any,
      skipArweave: true,
    });

    const regParams = mockRegisterAgent.mock.calls[0][0];
    expect(regParams.serviceDescriptors[0].serviceType).toBe('textgeneration');
  });

  test('rejects empty service types', async () => {
    const md = `---\nname: test\ncapabilities:\n  - ""\n---\n# Body`;
    mockReadFileSync.mockReturnValue(md);

    await expect(
      publishAgirailsMd({
        path: '/test/AGIRAILS.md',
        network: 'base-sepolia',
        registryAddress: '0xreg',
        signer: createMockSigner(),
        filebaseClient: createMockFilebaseClient() as any,
        skipArweave: true,
      })
    ).rejects.toThrow('Empty service type');
  });

  test('accepts valid service type formats', async () => {
    const md = `---\nname: test\ncapabilities:\n  - text-generation\n  - code-review-v2\n  - analysis\n---\n# Body`;
    mockReadFileSync.mockReturnValue(md);

    // Should not throw
    await publishAgirailsMd({
      path: '/test/AGIRAILS.md',
      network: 'base-sepolia',
      registryAddress: '0xreg',
      signer: createMockSigner(),
      filebaseClient: createMockFilebaseClient() as any,
      skipArweave: true,
    });
  });
});

// ============================================================================
// serviceTypes backward compatibility
// ============================================================================

describe('serviceTypes backward compatibility', () => {
  test('serviceTypes is normalized to capabilities', () => {
    const result = extractRegistrationParams({
      serviceTypes: ['code-review', 'bug-fixing'],
    });

    expect(result.serviceDescriptors).toHaveLength(2);
    expect(result.serviceDescriptors[0].serviceType).toBe('code-review');
    expect(result.serviceDescriptors[1].serviceType).toBe('bug-fixing');
    expect(result.endpoint).toBe(PENDING_ENDPOINT);
  });

  test('capabilities takes precedence over serviceTypes', () => {
    const result = extractRegistrationParams({
      capabilities: ['text-generation'],
      serviceTypes: ['code-review'],
    });

    expect(result.serviceDescriptors).toHaveLength(1);
    expect(result.serviceDescriptors[0].serviceType).toBe('text-generation');
  });

  test('serviceTypes with empty array still throws', () => {
    expect(() => extractRegistrationParams({
      serviceTypes: [],
    })).toThrow('services');
  });
});

// ============================================================================
// Pay-only intent: protocol-level guard against phantom provider registration
// ============================================================================

describe('extractRegistrationParams — intent: pay short-circuit', () => {
  test('returns empty serviceDescriptors when intent is pay, even with services present', () => {
    // Authoring drift safety net: if a pay-only file slips through with a
    // services block (e.g. handwritten by an LLM), we still must not
    // register it as a provider on AgentRegistry.
    const result = extractRegistrationParams({
      intent: 'pay',
      services: [{ type: 'code-review', price: '20', min_price: 5, max_price: 50 }],
    });
    expect(result.serviceDescriptors).toEqual([]);
  });

  test('returns empty serviceDescriptors when intent is pay with no services', () => {
    const result = extractRegistrationParams({
      intent: 'pay',
      servicesNeeded: ['translation'],
    });
    expect(result.serviceDescriptors).toEqual([]);
  });

  test('intent is case-insensitive (PAY same as pay)', () => {
    const result = extractRegistrationParams({
      intent: 'PAY',
      services: [{ type: 'code-review' }],
    });
    expect(result.serviceDescriptors).toEqual([]);
  });

  test('intent: both still registers as provider (not short-circuited)', () => {
    const result = extractRegistrationParams({
      intent: 'both',
      services: [{ type: 'code-review', price: '5', min_price: 4.95, max_price: 5.05 }],
    });
    expect(result.serviceDescriptors).toHaveLength(1);
    expect(result.serviceDescriptors[0].serviceType).toBe('code-review');
  });

  test('default intent (earn) registers as provider', () => {
    const result = extractRegistrationParams({
      services: [{ type: 'code-review' }],
    });
    expect(result.serviceDescriptors).toHaveLength(1);
  });

  test('preserves endpoint placeholder for pay-only', () => {
    const result = extractRegistrationParams({
      intent: 'pay',
      servicesNeeded: ['translation'],
    });
    expect(result.endpoint).toBe(PENDING_ENDPOINT);
  });
});
