import {
  collectERC8004MigrationInventory,
  fetchERC8004Artifact,
  ERC8004IdentityReader,
} from './inventory';

const MARKDOWN = `---\nname: observed-agent\nversion: "4.9.0"\n---\n# Observed Agent\n`;

function reader(overrides: Partial<ERC8004IdentityReader> = {}): ERC8004IdentityReader {
  return {
    ownerOf: jest.fn().mockResolvedValue('0x1111111111111111111111111111111111111111'),
    tokenURI: jest.fn().mockResolvedValue('ipfs://bafyobserved'),
    getAgentWallet: jest.fn().mockResolvedValue('0x2222222222222222222222222222222222222222'),
    ...overrides,
  };
}

function response(content: string, init: ResponseInit = {}): Response {
  return new Response(content, { status: 200, ...init });
}

describe('ERC-8004 read-only inventory', () => {
  test('collects registry and artifact evidence without a signer', async () => {
    const fetchFn = jest.fn().mockResolvedValue(response(MARKDOWN));
    const result = await collectERC8004MigrationInventory({
      network: 'base-sepolia',
      agentIds: ['42'],
      rpcUrl: 'https://rpc.example/v1/private-key?token=secret',
      reader: reader(),
      fetchFn,
      resolveHost: async () => ['93.184.216.34'],
      allowedHttpsHosts: ['public.example'],
      generatedAt: '2026-08-17T00:00:00.000Z',
    });

    expect(result.rpcEndpoint).toBe('https://rpc.example');
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.agents[0]).toMatchObject({
      chainId: 84532,
      agentId: '42',
      currentAgentURI: 'ipfs://bafyobserved',
      currentContent: MARKDOWN,
    });
    expect(result.failures).toEqual([]);
    expect(result.checks).toEqual({
      readOnly: true,
      signaturesRequested: 0,
      transactionsGenerated: 0,
    });
  });

  test('reads the deployed registry shape: tokenURI served, getAgentURI absent', async () => {
    // Mirrors the deployed canonical registry (ERC-8004 agent URI is ERC-721
    // tokenURI; the contract has no getAgentURI). Any read through getAgentURI
    // must fail this test loudly instead of being masked by a fallback.
    const deployedShapeReader = new Proxy(
      {
        ownerOf: jest.fn().mockResolvedValue('0x1111111111111111111111111111111111111111'),
        tokenURI: jest.fn().mockResolvedValue('ipfs://bafyobserved'),
        getAgentWallet: jest.fn().mockResolvedValue('0x2222222222222222222222222222222222222222'),
      },
      {
        get(target, property, receiver) {
          if (property === 'getAgentURI') {
            throw new Error('deployed registry does not serve getAgentURI');
          }
          return Reflect.get(target, property, receiver);
        },
      }
    ) as unknown as ERC8004IdentityReader;

    const result = await collectERC8004MigrationInventory({
      network: 'base-sepolia',
      agentIds: ['6732'],
      reader: deployedShapeReader,
      fetchFn: jest.fn().mockResolvedValue(response(MARKDOWN)),
      resolveHost: async () => ['93.184.216.34'],
      generatedAt: '2026-08-20T00:00:00.000Z',
    });

    expect(result.failures).toEqual([]);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      agentId: '6732',
      currentAgentURI: 'ipfs://bafyobserved',
      currentContent: MARKDOWN,
    });
  });

  test('retains per-agent failures instead of silently dropping evidence', async () => {
    const result = await collectERC8004MigrationInventory({
      network: 'base-sepolia',
      agentIds: ['42'],
      reader: reader({ ownerOf: jest.fn().mockRejectedValue(new Error('RPC timeout')) }),
      fetchFn: jest.fn(),
      generatedAt: '2026-08-17T00:00:00.000Z',
    });

    expect(result.agents).toEqual([]);
    expect(result.failures).toEqual([{ agentId: '42', error: 'RPC timeout' }]);
  });

  test('redacts credentialed RPC URLs from per-agent failure evidence', async () => {
    const privateRpcUrl = 'https://rpc.example/v1/private-key?token=secret';
    const result = await collectERC8004MigrationInventory({
      network: 'base-sepolia',
      agentIds: ['42'],
      rpcUrl: privateRpcUrl,
      reader: reader({
        ownerOf: jest.fn().mockRejectedValue(new Error(`RPC request failed at ${privateRpcUrl}`)),
      }),
      fetchFn: jest.fn(),
      generatedAt: '2026-08-17T00:00:00.000Z',
    });

    expect(result.failures[0].error).toContain('[redacted RPC URL]');
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('blocks local HTTPS targets before fetching', async () => {
    const fetchFn = jest.fn();
    await expect(
      fetchERC8004Artifact('https://localhost/metadata.json', {
        fetchFn,
        resolveHost: async () => ['127.0.0.1'],
      })
    ).rejects.toThrow('local hostname');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test.each([
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:172.16.0.8',
    '::ffff:192.168.1.8',
    '2001:db8::1',
    'ff02::1',
  ])('blocks private or reserved IPv6 resolution %s', async (address) => {
    const fetchFn = jest.fn();
    await expect(
      fetchERC8004Artifact('https://public.example/metadata.json', {
        fetchFn,
        resolveHost: async () => [address],
        allowedHttpsHosts: ['public.example'],
      })
    ).rejects.toThrow('private, local, or reserved');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('validates every redirect target and blocks private destinations', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        response('', { status: 302, headers: { location: 'https://metadata.internal/agent' } })
      );
    await expect(
      fetchERC8004Artifact('https://public.example/metadata.json', {
        fetchFn,
        resolveHost: async (hostname) =>
          hostname === 'public.example' ? ['93.184.216.34'] : ['10.0.0.8'],
        allowedHttpsHosts: ['public.example', 'metadata.internal'],
      })
    ).rejects.toThrow('private, local, or reserved');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('enforces the artifact size limit even without content-length', async () => {
    await expect(
      fetchERC8004Artifact('https://public.example/metadata.json', {
        fetchFn: jest.fn().mockResolvedValue(response('too large')),
        resolveHost: async () => ['93.184.216.34'],
        allowedHttpsHosts: ['public.example'],
        maxBytes: 3,
      })
    ).rejects.toThrow('exceeds 3 bytes');
  });

  test('cancels a streaming response as soon as it crosses the artifact size limit', async () => {
    const cancel = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('abc'));
        controller.enqueue(new TextEncoder().encode('def'));
      },
      cancel,
    });

    await expect(
      fetchERC8004Artifact('https://public.example/metadata.json', {
        fetchFn: jest.fn().mockResolvedValue(new Response(body, { status: 200 })),
        resolveHost: async () => ['93.184.216.34'],
        allowedHttpsHosts: ['public.example'],
        maxBytes: 5,
      })
    ).rejects.toThrow('exceeds 5 bytes');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('decodes supported data URIs without network access', async () => {
    await expect(
      fetchERC8004Artifact('data:application/json,%7B%22type%22%3A%22x%22%7D')
    ).resolves.toBe('{"type":"x"}');
  });

  test('normalizes arbitrarily long gateway slash suffixes without a regular expression', async () => {
    const fetchFn = jest.fn().mockResolvedValue(response(MARKDOWN));
    await expect(
      fetchERC8004Artifact('ipfs://bafyobserved', {
        fetchFn,
        resolveHost: async () => ['93.184.216.34'],
        ipfsGateway: `https://ipfs.example/ipfs/${'/'.repeat(10_000)}`,
      })
    ).resolves.toBe(MARKDOWN);

    expect(String(fetchFn.mock.calls[0][0])).toBe(
      'https://ipfs.example/ipfs/bafyobserved'
    );
  });

  test('requires explicit approval for non-IPFS HTTPS artifact hosts', async () => {
    const fetchFn = jest.fn();
    await expect(
      fetchERC8004Artifact('https://metadata.example/agent.json', {
        fetchFn,
        resolveHost: async () => ['93.184.216.34'],
      })
    ).rejects.toThrow('host is not approved');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('rejects duplicate and malformed identity lists before RPC reads', async () => {
    await expect(
      collectERC8004MigrationInventory({
        network: 'base-sepolia',
        agentIds: ['42', '42'],
        reader: reader(),
      })
    ).rejects.toThrow('Duplicate');
    await expect(
      collectERC8004MigrationInventory({
        network: 'base-sepolia',
        agentIds: ['-1'],
        reader: reader(),
      })
    ).rejects.toThrow('unsigned decimal');
    await expect(
      collectERC8004MigrationInventory({
        network: 'base-sepolia',
        agentIds: [(1n << 256n).toString()],
        reader: reader(),
      })
    ).rejects.toThrow('exceeds uint256');
  });
});
