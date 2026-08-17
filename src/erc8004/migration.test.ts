import {
  createERC8004MigrationLedger,
  createERC8004MigrationRecord,
  ERC8004MigrationInput,
} from './migration';

const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const OWNER = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const CURRENT_URI = 'ipfs://bafy-legacy-markdown';
const MARKDOWN = `---
name: migration-agent
version: "4.9.0"
capabilities:
  - testing
---
# Migration Agent

Tests migration plans.
`;

function input(overrides: Partial<ERC8004MigrationInput> = {}): ERC8004MigrationInput {
  return {
    chainId: 84532,
    registryAddress: REGISTRY,
    agentId: '42',
    owner: OWNER,
    agentWallet: WALLET,
    currentAgentURI: CURRENT_URI,
    currentContent: MARKDOWN,
    ...overrides,
  };
}

describe('ERC-8004 migration planning', () => {
  test('creates a no-transaction before/after record for legacy Markdown', () => {
    const record = createERC8004MigrationRecord(input());

    expect(record.status).toBe('needs-upload');
    expect(record.before).toMatchObject({
      agentURI: CURRENT_URI,
      artifactType: 'agirails-markdown',
    });
    expect(record.after?.registration.registrations).toEqual([
      {
        agentId: '42',
        agentRegistry: `eip155:84532:${REGISTRY}`,
      },
    ]);
    expect(record.after?.registration.services).toEqual([
      { name: 'AGIRAILS', endpoint: CURRENT_URI, version: '4.9.0' },
    ]);
    expect(record.checks).toEqual({
      transactionGenerated: false,
      paymentWalletChanged: false,
      paymentWalletUsable: true,
      targetContentVerified: false,
    });
    expect(record.after?.observedAgentWallet).toBe(WALLET);
  });

  test('marks an exact uploaded target as ready', () => {
    const draft = createERC8004MigrationRecord(input());
    const record = createERC8004MigrationRecord(input({
      targetAgentURI: 'ipfs://bafy-registration-v1',
      targetContent: draft.after?.serializedRegistration,
    }));

    expect(record.status).toBe('ready');
    expect(record.after?.targetAgentURI).toBe('ipfs://bafy-registration-v1');
    expect(record.checks.targetContentVerified).toBe(true);
  });

  test('blocks a target whose JSON differs from the generated projection', () => {
    const draft = createERC8004MigrationRecord(input());
    const different = JSON.parse(draft.after!.serializedRegistration);
    different.description = 'Substituted content';

    const record = createERC8004MigrationRecord(input({
      targetAgentURI: 'ipfs://bafy-wrong',
      targetContent: JSON.stringify(different),
    }));

    expect(record.status).toBe('blocked');
    expect(record.blocker).toContain('does not match');
  });

  test('does not rewrite an existing registration-v1 artifact', () => {
    const draft = createERC8004MigrationRecord(input());
    const record = createERC8004MigrationRecord(input({
      currentContent: draft.after?.serializedRegistration,
      currentAgentURI: 'ipfs://bafy-existing-registration',
    }));

    expect(record.status).toBe('already-registration-v1');
    expect(record.after).toBeUndefined();
  });

  test('blocks registration-v1-shaped JSON that does not validate', () => {
    const record = createERC8004MigrationRecord(input({
      currentContent: JSON.stringify({
        type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        name: 'Invalid',
      }),
    }));

    expect(record.status).toBe('blocked');
    expect(record.before.artifactType).toBe('registration-v1');
    expect(record.blocker).toContain('registration-v1 JSON is invalid');
  });

  test('plans a registration binding update when the identity reference is absent', () => {
    const draft = createERC8004MigrationRecord(input());
    const registrationWithoutIdentity = {
      ...draft.after!.registration,
      registrations: [],
    };

    const record = createERC8004MigrationRecord(input({
      currentContent: JSON.stringify(registrationWithoutIdentity),
      currentAgentURI: 'ipfs://bafy-unbound-registration',
    }));

    expect(record.status).toBe('needs-upload');
    expect(record.before.artifactType).toBe('registration-v1');
    expect(record.after?.registration.registrations).toEqual([
      {
        agentId: '42',
        agentRegistry: `eip155:84532:${REGISTRY}`,
      },
    ]);
  });

  test('blocks unknown current content with explicit evidence', () => {
    const record = createERC8004MigrationRecord(input({ currentContent: '<html>not metadata</html>' }));

    expect(record.status).toBe('blocked');
    expect(record.before.artifactType).toBe('unknown');
    expect(record.blocker).toContain('neither registration-v1 JSON nor AGIRAILS Markdown');
  });

  test('blocks a target URI when target content is unavailable', () => {
    const record = createERC8004MigrationRecord(input({
      targetAgentURI: 'ipfs://bafy-unavailable',
    }));

    expect(record.status).toBe('blocked');
    expect(record.blocker).toContain('could not be verified');
  });

  test('rejects invalid and duplicate inventory identities', () => {
    expect(() => createERC8004MigrationRecord(input({ agentId: '-1' }))).toThrow(
      'uint256 decimal string'
    );
    expect(() => createERC8004MigrationRecord(input({
      agentId: (1n << 256n).toString(),
    }))).toThrow(
      'uint256 decimal string'
    );
    expect(() => createERC8004MigrationLedger([input(), input()])).toThrow(
      'Duplicate ERC-8004 migration identity'
    );
  });

  test.each([
    'https://',
    'https://user:secret@metadata.example/agent.json',
    'ipfs://../registration.json',
    'ipfs://bafyvalid//registration.json',
  ])('rejects malformed or credentialed migration URIs: %s', (targetAgentURI) => {
    expect(() =>
      createERC8004MigrationRecord(input({ targetAgentURI, targetContent: '{}' }))
    ).toThrow(/targetAgentURI/);
  });

  test('rejects Markdown data URIs as registration-v1 migration targets', () => {
    expect(() =>
      createERC8004MigrationRecord(input({
        targetAgentURI: 'data:text/markdown,%23%20Not%20registration-v1',
        targetContent: '# Not registration-v1',
      }))
    ).toThrow(/targetAgentURI/);
  });

  test('records an unset registry wallet without describing it as payment-usable', () => {
    const zero = '0x0000000000000000000000000000000000000000';
    const record = createERC8004MigrationRecord(input({ agentWallet: zero }));

    expect(record.identity.observedAgentWallet).toBe(zero);
    expect(record.after?.observedAgentWallet).toBe(zero);
    expect(record.checks.paymentWalletUsable).toBe(false);
    expect(record.checks.paymentWalletChanged).toBe(false);
  });

  test('resumes an unchanged human decision and resets it when evidence changes', () => {
    const first = createERC8004MigrationLedger(
      [input()],
      undefined,
      '2026-08-17T12:00:00.000Z'
    );
    first.records[0].review = {
      status: 'approved',
      reviewedAt: '2026-08-17T12:01:00.000Z',
      reviewedBy: 'Damir',
    };

    const resumed = createERC8004MigrationLedger(
      [input()],
      first,
      '2026-08-17T12:02:00.000Z'
    );
    expect(resumed.records[0].review.status).toBe('approved');

    const changed = createERC8004MigrationLedger(
      [input({ agentWallet: '0x3333333333333333333333333333333333333333' })],
      first,
      '2026-08-17T12:03:00.000Z'
    );
    expect(changed.records[0].review).toEqual({ status: 'pending' });
  });
});
