import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseERC8004MigrationInventory,
  runERC8004Inventory,
  runERC8004MigrationPlan,
} from './erc8004';
import * as inventoryModule from '../../erc8004/inventory';

const MARKDOWN = `---
name: migration-agent
version: "4.9.0"
capabilities:
  - testing
---
# Migration Agent

Tests migration plans.
`;

function inventory(agentWallet = '0x2222222222222222222222222222222222222222') {
  return {
    version: 1,
    agents: [
      {
        chainId: 84532,
        registryAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        agentId: '42',
        owner: '0x1111111111111111111111111111111111111111',
        agentWallet,
        currentAgentURI: 'ipfs://bafy-legacy-markdown',
        currentContent: MARKDOWN,
      },
    ],
  };
}

describe('erc8004 migration-plan command', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'actp-erc8004-plan-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test('writes a no-transaction before/after ledger', () => {
    const inputPath = join(directory, 'inventory.json');
    const outputPath = join(directory, 'ledger.json');
    writeFileSync(inputPath, JSON.stringify(inventory()));

    const ledger = runERC8004MigrationPlan({ input: inputPath, output: outputPath });
    const persisted = JSON.parse(readFileSync(outputPath, 'utf-8'));

    expect(ledger.records).toHaveLength(1);
    expect(persisted.records[0].status).toBe('needs-upload');
    expect(persisted.records[0].checks).toEqual({
      transactionGenerated: false,
      paymentWalletChanged: false,
      paymentWalletUsable: true,
      targetContentVerified: false,
    });
    expect(persisted.records[0].review).toEqual({ status: 'pending' });
  });

  test('preserves approval on identical evidence and resets it after a wallet change', () => {
    const inputPath = join(directory, 'inventory.json');
    const outputPath = join(directory, 'ledger.json');
    writeFileSync(inputPath, JSON.stringify(inventory()));
    runERC8004MigrationPlan({ input: inputPath, output: outputPath });

    const approved = JSON.parse(readFileSync(outputPath, 'utf-8'));
    approved.records[0].review = { status: 'approved', reviewedBy: 'Damir' };
    writeFileSync(outputPath, JSON.stringify(approved));
    const resumed = runERC8004MigrationPlan({ input: inputPath, output: outputPath });
    expect(resumed.records[0].review.status).toBe('approved');

    writeFileSync(
      inputPath,
      JSON.stringify(inventory('0x3333333333333333333333333333333333333333'))
    );
    const changed = runERC8004MigrationPlan({ input: inputPath, output: outputPath });
    expect(changed.records[0].review).toEqual({ status: 'pending' });
  });

  test('rejects malformed inventory before writing a ledger', () => {
    expect(() => parseERC8004MigrationInventory('{')).toThrow('must be valid JSON');
    expect(() => parseERC8004MigrationInventory(JSON.stringify({ version: 1 }))).toThrow(
      'agents array'
    );
  });
});

describe('erc8004 inventory command', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'actp-erc8004-inventory-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  test('writes an atomic read-only inventory artifact', async () => {
    const outputPath = join(directory, 'inventory.json');
    jest.spyOn(inventoryModule, 'collectERC8004MigrationInventory').mockResolvedValue({
      version: 1,
      generatedAt: '2026-08-17T00:00:00.000Z',
      network: 'base-sepolia',
      rpcEndpoint: 'https://sepolia.base.org',
      agents: inventory().agents,
      failures: [],
      checks: { readOnly: true, signaturesRequested: 0, transactionsGenerated: 0 },
    });

    const result = await runERC8004Inventory({
      network: 'base-sepolia',
      agentId: ['42'],
      output: outputPath,
    });

    expect(result.agents).toHaveLength(1);
    expect(JSON.parse(readFileSync(outputPath, 'utf-8')).checks.transactionsGenerated).toBe(0);
  });
});
