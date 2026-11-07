import {
  buildERC8004RegistrationV1,
  DEFAULT_ERC8004_IMAGE_URI,
  ERC8004_REGISTRATION_V1_TYPE,
  serializeERC8004RegistrationV1,
  validateERC8004RegistrationV1,
} from './registration';

describe('ERC-8004 registration-v1 projection', () => {
  const frontmatter = {
    name: 'Code Reviewer',
    version: '4.9.0',
    image: 'https://agirails.app/a/reviewer/avatar.png',
    endpoint: 'https://execution.example/review',
    payment: { modes: ['actp', 'x402'] },
  };

  test('keeps the AGIRAILS Markdown as a separate service artifact', () => {
    const result = buildERC8004RegistrationV1({
      frontmatter,
      body: '# Code Reviewer\n\nReviews source code.',
      agirailsConfigURI: 'ipfs://bafy-config',
    });

    expect(result).toEqual({
      type: ERC8004_REGISTRATION_V1_TYPE,
      name: 'Code Reviewer',
      description: 'Reviews source code.',
      image: 'https://agirails.app/a/reviewer/avatar.png',
      services: [
        { name: 'AGIRAILS', endpoint: 'ipfs://bafy-config', version: '4.9.0' },
      ],
      x402Support: false,
      active: true,
      registrations: [],
    });
  });

  test('does not infer A2A or x402 support from generic authored fields', () => {
    const result = buildERC8004RegistrationV1({
      frontmatter,
      body: 'Description',
      agirailsConfigURI: 'ipfs://bafy-config',
    });

    expect(result.services.map((service) => service.name)).toEqual(['AGIRAILS']);
    expect(result.image).toBe('https://agirails.app/a/reviewer/avatar.png');
    expect(result.x402Support).toBe(false);
    expect(result).not.toHaveProperty('supportedTrust');
  });

  test('keeps mandatory image and description fields valid for legacy cards', () => {
    const result = buildERC8004RegistrationV1({
      frontmatter: { name: 'Legacy Agent' },
      body:
        '# Legacy Agent\n\nConcise public description.\n\n' +
        '## How to Request This Service\n\nOperational instructions that are not identity metadata.',
      agirailsConfigURI: 'ipfs://bafy-config',
    });

    expect(result.image).toBe(DEFAULT_ERC8004_IMAGE_URI);
    expect(result.description).toBe('Concise public description.');
  });

  test('can bind an existing identity without predicting a new token ID', () => {
    const result = buildERC8004RegistrationV1({
      frontmatter,
      body: 'Description',
      agirailsConfigURI: 'ipfs://bafy-config',
      registration: {
        agentId: '123',
        agentRegistry: 'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e',
      },
    });

    expect(result.registrations).toEqual([
      {
        agentId: '123',
        agentRegistry: 'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e',
      },
    ]);
  });

  test('rejects missing names and unresolvable config URIs', () => {
    expect(() =>
      buildERC8004RegistrationV1({
        frontmatter: {},
        body: 'Description',
        agirailsConfigURI: 'ipfs://bafy-config',
      })
    ).toThrow('non-empty agent name');

    expect(() =>
      buildERC8004RegistrationV1({
        frontmatter: { name: 'Agent' },
        body: 'Description',
        agirailsConfigURI: 'file:///tmp/config.md',
      })
    ).toThrow('https, ipfs, or data');

    for (const agirailsConfigURI of ['https://', 'ipfs://', 'https://user:pass@example.com/a']) {
      expect(() =>
        buildERC8004RegistrationV1({
          frontmatter: { name: 'Agent' },
          body: 'Description',
          agirailsConfigURI,
        })
      ).toThrow('https, ipfs, or data');
    }
  });

  test('rejects malformed explicitly authored registration fields instead of dropping them', () => {
    for (const frontmatter of [
      { name: 'Agent', description: 42 },
      { name: 'Agent', version: 4.9 },
      { name: 'Agent', image: 'javascript:alert(1)' },
    ]) {
      expect(() =>
        buildERC8004RegistrationV1({
          frontmatter,
          body: 'Description',
          agirailsConfigURI: 'ipfs://bafy-config',
        })
      ).toThrow();
    }
  });

  test('validator rejects unsupported type and unverified x402 claims', () => {
    expect(() => validateERC8004RegistrationV1({ type: 'wrong' })).toThrow('type must be');

    const valid = buildERC8004RegistrationV1({
      frontmatter: { name: 'Agent' },
      body: 'Description',
      agirailsConfigURI: 'ipfs://bafy-config',
    });
    expect(() => validateERC8004RegistrationV1({ ...valid, x402Support: true })).toThrow(
      'Unverified x402Support'
    );
    expect(() => validateERC8004RegistrationV1({ ...valid, image: undefined })).toThrow(
      'image must be'
    );
    expect(() =>
      validateERC8004RegistrationV1({ ...valid, supportedTrust: ['reputation'] })
    ).toThrow('unsupported fields');
    expect(() =>
      validateERC8004RegistrationV1({
        ...valid,
        services: [
          { name: 'A2A', endpoint: 'https://agent.example/.well-known/agent-card.json' },
        ],
      })
    ).toThrow('AGIRAILS service');
  });

  test('validator rejects non-EIP-155 registration references', () => {
    const valid = buildERC8004RegistrationV1({
      frontmatter: { name: 'Agent' },
      body: 'Description',
      agirailsConfigURI: 'ipfs://bafy-config',
    });

    expect(() =>
      validateERC8004RegistrationV1({
        ...valid,
        registrations: [{ agentId: '123', agentRegistry: 'base-sepolia:0x1234' }],
      })
    ).toThrow('EIP-155 registry');

    for (const agentRegistry of [
      'eip155:84532:0x0000000000000000000000000000000000000000',
      `eip155:${(1n << 256n).toString()}:0x1111111111111111111111111111111111111111`,
    ]) {
      expect(() =>
        validateERC8004RegistrationV1({
          ...valid,
          registrations: [{ agentId: '123', agentRegistry }],
        })
      ).toThrow('EIP-155 registry');
    }
  });

  test('validator rejects executable data URIs and agent IDs above uint256', () => {
    const base = buildERC8004RegistrationV1({
      frontmatter: { name: 'safe-agent', description: 'safe' },
      body: '',
      agirailsConfigURI: 'ipfs://bafy-config',
    });
    expect(() =>
      validateERC8004RegistrationV1({
        ...base,
        image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      })
    ).toThrow('data image URI');
    expect(() =>
      validateERC8004RegistrationV1({
        ...base,
        services: [{ name: 'AGIRAILS', endpoint: 'data:application/javascript,alert(1)' }],
      })
    ).toThrow('data URI');
    expect(() =>
      validateERC8004RegistrationV1({
        ...base,
        registrations: [
          {
            agentId: (1n << 256n).toString(),
            agentRegistry: 'eip155:84532:0x1111111111111111111111111111111111111111',
          },
        ],
      })
    ).toThrow('agentId');
  });

  test('serialization is deterministic JSON with a trailing newline', () => {
    const registration = buildERC8004RegistrationV1({
      frontmatter: { name: 'Agent' },
      body: 'Description',
      agirailsConfigURI: 'ipfs://bafy-config',
    });

    const first = serializeERC8004RegistrationV1(registration);
    const second = serializeERC8004RegistrationV1(registration);
    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    expect(JSON.parse(first)).toEqual(registration);
  });

  test('rejects a registration that exceeds the publish-proxy byte limit', () => {
    const registration = buildERC8004RegistrationV1({
      frontmatter: { name: 'Agent' },
      body: 'x'.repeat(11 * 1024),
      agirailsConfigURI: 'ipfs://bafy-config',
    });

    expect(() => serializeERC8004RegistrationV1(registration)).toThrow(
      'ERC-8004 registration exceeds 10240 bytes'
    );
  });
});
