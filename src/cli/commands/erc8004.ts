/**
 * Read-only ERC-8004 maintenance commands.
 *
 * The migration planner consumes an evidence inventory, emits a resumable
 * before/after ledger, and never performs RPC writes, uploads, signatures, or
 * transactions. A human review is preserved only while its evidence is
 * byte-for-byte unchanged.
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  createERC8004MigrationLedger,
  ERC8004MigrationInput,
  ERC8004MigrationLedger,
} from '../../erc8004/migration';
import {
  collectERC8004MigrationInventory,
  ERC8004InventoryFile,
  ERC8004InventoryNetwork,
} from '../../erc8004/inventory';

interface MigrationInventoryFile {
  version: 1;
  agents: ERC8004MigrationInput[];
}

interface MigrationPlanOptions {
  input: string;
  output: string;
  stdout?: boolean;
}

interface InventoryOptions {
  network: ERC8004InventoryNetwork;
  agentId: string[];
  output: string;
  rpcUrl?: string;
  allowHost?: string[];
  stdout?: boolean;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function writeAtomicJson(path: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Ignore cleanup failures and preserve the original write/rename error.
    }
    throw error;
  }
}

export async function runERC8004Inventory(options: InventoryOptions): Promise<ERC8004InventoryFile> {
  const inventory = await collectERC8004MigrationInventory({
    network: options.network,
    agentIds: options.agentId,
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
    ...(options.allowHost ? { allowedHttpsHosts: options.allowHost } : {}),
  });
  if (options.stdout) {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  } else {
    writeAtomicJson(resolve(options.output), inventory);
  }
  return inventory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireStringField(
  value: Record<string, unknown>,
  key: string,
  index: number
): string {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new Error(`Migration inventory agents[${index}].${key} must be a string`);
  }
  return field;
}

function parseMigrationInput(value: unknown, index: number): ERC8004MigrationInput {
  if (!isRecord(value)) {
    throw new Error(`Migration inventory agents[${index}] must be an object`);
  }

  if (typeof value.chainId !== 'number') {
    throw new Error(`Migration inventory agents[${index}].chainId must be a number`);
  }
  for (const key of ['targetAgentURI', 'targetContent'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`Migration inventory agents[${index}].${key} must be a string when present`);
    }
  }

  return {
    chainId: value.chainId,
    registryAddress: requireStringField(value, 'registryAddress', index),
    agentId: requireStringField(value, 'agentId', index),
    owner: requireStringField(value, 'owner', index),
    agentWallet: requireStringField(value, 'agentWallet', index),
    currentAgentURI: requireStringField(value, 'currentAgentURI', index),
    currentContent: requireStringField(value, 'currentContent', index),
    ...(typeof value.targetAgentURI === 'string'
      ? { targetAgentURI: value.targetAgentURI }
      : {}),
    ...(typeof value.targetContent === 'string' ? { targetContent: value.targetContent } : {}),
  };
}

export function parseERC8004MigrationInventory(raw: string): MigrationInventoryFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Migration inventory must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.agents)) {
    throw new Error('Migration inventory must contain version: 1 and an agents array');
  }
  return {
    version: 1,
    agents: value.agents.map(parseMigrationInput),
  };
}

function parsePreviousLedger(raw: string): ERC8004MigrationLedger {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) {
    throw new Error('Existing migration ledger is not a supported version-1 ledger');
  }
  for (const [index, record] of value.records.entries()) {
    if (
      !isRecord(record) ||
      typeof record.agentId !== 'string' ||
      !isRecord(record.identity) ||
      typeof record.identity.agentRegistry !== 'string' ||
      !isRecord(record.review) ||
      !['pending', 'approved', 'rejected'].includes(String(record.review.status))
    ) {
      throw new Error(`Existing migration ledger records[${index}] is invalid`);
    }
  }
  return value as unknown as ERC8004MigrationLedger;
}

export function runERC8004MigrationPlan(options: MigrationPlanOptions): ERC8004MigrationLedger {
  const inputPath = resolve(options.input);
  const outputPath = resolve(options.output);
  const inventory = parseERC8004MigrationInventory(readFileSync(inputPath, 'utf-8'));
  const previous = existsSync(outputPath)
    ? parsePreviousLedger(readFileSync(outputPath, 'utf-8'))
    : undefined;
  const ledger = createERC8004MigrationLedger(inventory.agents, previous);
  const serialized = `${JSON.stringify(ledger, null, 2)}\n`;

  if (options.stdout) {
    process.stdout.write(serialized);
  } else {
    writeAtomicJson(outputPath, ledger);
  }
  return ledger;
}

export function createERC8004Command(): Command {
  const command = new Command('erc8004').description(
    'Read-only ERC-8004 inspection and migration planning'
  );

  command
    .command('inventory')
    .description('Read explicit identities and resolve current agentURI artifacts; never writes on-chain')
    .requiredOption(
      '-n, --network <network>',
      'Registry network (base-sepolia or base-mainnet)'
    )
    .requiredOption(
      '-a, --agent-id <id>',
      'ERC-8004 token ID; repeat for multiple identities',
      collectOption,
      []
    )
    .option('-o, --output <path>', 'Inventory path', 'erc8004-inventory.json')
    .option('--rpc-url <url>', 'Read-only RPC override; never persisted in full')
    .option(
      '--allow-host <hostname>',
      'Explicitly allow an HTTPS artifact host; repeat as needed',
      collectOption,
      []
    )
    .option('--stdout', 'Print the inventory without writing a file')
    .action(async (options: InventoryOptions) => {
      if (!['base-sepolia', 'base-mainnet'].includes(options.network)) {
        throw new Error('ERC-8004 inventory network must be base-sepolia or base-mainnet');
      }
      const inventory = await runERC8004Inventory(options);
      if (!options.stdout) {
        process.stdout.write(
          `${JSON.stringify({
            ok: inventory.failures.length === 0,
            readOnly: true,
            output: resolve(options.output),
            observed: inventory.agents.length,
            failures: inventory.failures.length,
            signaturesRequested: 0,
            transactionsGenerated: 0,
          })}\n`
        );
      }
      if (inventory.failures.length > 0) process.exitCode = 2;
    });

  command
    .command('migration-plan')
    .description(
      'Generate a resumable dry-run ledger; never uploads, signs, or submits transactions'
    )
    .requiredOption('-i, --input <path>', 'Version-1 JSON inventory with observed identities')
    .option('-o, --output <path>', 'Ledger path', 'erc8004-migration-plan.json')
    .option('--stdout', 'Print the ledger without writing a file')
    .action((options: MigrationPlanOptions) => {
      const ledger = runERC8004MigrationPlan(options);
      if (!options.stdout) {
        const counts = ledger.records.reduce<Record<string, number>>((result, record) => {
          result[record.status] = (result[record.status] ?? 0) + 1;
          return result;
        }, {});
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            dryRun: true,
            output: resolve(options.output),
            records: ledger.records.length,
            status: counts,
            transactionsGenerated: 0,
          })}\n`
        );
      }
    });

  return command;
}
