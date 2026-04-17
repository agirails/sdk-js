/**
 * Repair Command — reshape an already-on-chain agent without redeploying.
 *
 * Use cases:
 *   - Drop a phantom service registered by an earlier misshape (e.g. a
 *     pay-only agent that was registered as `code-review` provider before
 *     the intent-aware publish flow existed).
 *   - Update the on-chain endpoint to a real HTTPS URL after wiring a
 *     webhook for x402 / off-protocol intake.
 *   - Toggle isActive / listed flags to hide from public discovery.
 *
 * Wraps existing AgentRegistry SDK methods; this command is the user-
 * facing surface that explains what's about to change and asks for
 * confirmation before sending the tx.
 *
 * Deliberately does NOT expose `deregisterAgent` — destructive ops that
 * forfeit reputation belong in a separate command with bigger guards.
 *
 * @module cli/commands/repair
 */

import { Command } from 'commander';
import { ethers } from 'ethers';
import * as readline from 'readline';
import { Output, ExitCode, fmt } from '../utils/output';
import { mapError } from '../utils/client';
import { loadConfig } from '../utils/config';
import { getNetwork } from '../../config/networks';
import { AgentRegistry } from '../../protocol/AgentRegistry';
import { AgentRegistryClient } from '../../registry/AgentRegistryClient';

// ============================================================================
// Command
// ============================================================================

export function createRepairCommand(): Command {
  const cmd = new Command('repair')
    .description('Reshape on-chain agent (drop phantom services, update endpoint, toggle active/listed)')
    .option('--remove-service <name>', 'Remove a service type from your on-chain provider role')
    .option('--endpoint <url>', 'Update on-chain endpoint URL (must be HTTPS)')
    .option('--active <bool>', 'Set on-chain isActive (true|false)')
    .option('--listed <bool>', 'Set on-chain listed flag (true|false)')
    .option('--network <name>', 'Network to repair on', 'base-sepolia')
    .option('-y, --yes', 'Skip confirmation prompts (required for non-TTY)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const output = new Output(options.json ? 'json' : 'human');
      try {
        await runRepair(options, output);
      } catch (error) {
        const structured = mapError(error);
        output.errorResult({
          code: structured.code,
          message: structured.message,
          details: structured.details,
        });
        process.exit(ExitCode.ERROR);
      }
    });

  return cmd;
}

// ============================================================================
// Implementation
// ============================================================================

interface RepairOptions {
  removeService?: string;
  endpoint?: string;
  active?: string;
  listed?: string;
  network: string;
  yes?: boolean;
  json?: boolean;
}

async function runRepair(options: RepairOptions, output: Output): Promise<void> {
  // At least one repair action must be specified.
  const actions = [
    options.removeService && `remove-service ${options.removeService}`,
    options.endpoint && `endpoint → ${options.endpoint}`,
    options.active !== undefined && `active → ${options.active}`,
    options.listed !== undefined && `listed → ${options.listed}`,
  ].filter(Boolean) as string[];

  if (actions.length === 0) {
    throw new Error(
      'No repair action specified. Use one of:\n' +
        '  --remove-service <name>\n' +
        '  --endpoint <url>\n' +
        '  --active <true|false>\n' +
        '  --listed <true|false>'
    );
  }

  // Validate inputs early — fail before touching the network.
  if (options.endpoint !== undefined && !options.endpoint.startsWith('https://')) {
    throw new Error(`--endpoint must be HTTPS (got: ${options.endpoint})`);
  }
  const activeBool = options.active !== undefined ? parseBool(options.active, '--active') : undefined;
  const listedBool = options.listed !== undefined ? parseBool(options.listed, '--listed') : undefined;

  // Load signer.
  const config = loadConfig();
  const { resolvePrivateKey } = await import('../../wallet/keystore');
  const network = options.network;
  const tier = network.includes('mainnet') ? 'mainnet' : network.includes('sepolia') ? 'testnet' : 'mock';
  const privateKey = await resolvePrivateKey(process.cwd(), { network: tier as 'mainnet' | 'testnet' | 'mock' });
  if (!privateKey) {
    throw new Error('No wallet found. Set ACTP_KEYSTORE_BASE64 or run `actp init` first.');
  }

  const networkConfig = getNetwork(network);
  if (!networkConfig.contracts.agentRegistry) {
    throw new Error(`AgentRegistry not configured for network: ${network}`);
  }

  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();
  void config;

  // Confirm before sending.
  output.info(`About to repair on-chain agent for wallet: ${signerAddress}`);
  output.print('  Network: ' + network);
  output.print('  Actions:');
  for (const a of actions) output.print(`    - ${a}`);

  const confirmed = await confirm(options, output);
  if (!confirmed) {
    output.info('Cancelled — no on-chain transactions sent.');
    return;
  }

  const registry = new AgentRegistry(networkConfig.contracts.agentRegistry, signer, networkConfig.gasSettings);

  const txHashes: { action: string; txHash: string }[] = [];

  // Sequential execution — each call is its own tx; if one fails the
  // earlier ones already landed and the user can retry the rest.
  if (options.removeService) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(options.removeService));
    output.print('');
    output.print(`Removing service "${options.removeService}" (hash ${hash.slice(0, 10)}...)`);
    const txHash = await registry.removeServiceType(hash);
    txHashes.push({ action: `remove-service:${options.removeService}`, txHash });
    output.success(`Removed. tx: ${txHash}`);
  }

  if (options.endpoint !== undefined) {
    output.print('');
    output.print(`Updating endpoint → ${options.endpoint}`);
    const txHash = await registry.updateEndpoint(options.endpoint);
    txHashes.push({ action: `update-endpoint`, txHash });
    output.success(`Updated. tx: ${txHash}`);
  }

  if (activeBool !== undefined) {
    output.print('');
    output.print(`Setting active → ${activeBool}`);
    const txHash = await registry.setActiveStatus(activeBool);
    txHashes.push({ action: `set-active:${activeBool}`, txHash });
    output.success(`Set. tx: ${txHash}`);
  }

  if (listedBool !== undefined) {
    // setListed lives on AgentRegistryClient (the v2 listing surface),
    // not on the legacy AgentRegistry wrapper used for the other repair
    // ops. Cheap to instantiate; both share the same contract address.
    const listingClient = new AgentRegistryClient(
      networkConfig.contracts.agentRegistry,
      signer,
      networkConfig.gasSettings,
    );
    output.print('');
    output.print(`Setting listed → ${listedBool}`);
    const txHash = await listingClient.setListed(listedBool);
    txHashes.push({ action: `set-listed:${listedBool}`, txHash });
    output.success(`Set. tx: ${txHash}`);
  }

  output.print('');
  output.success(`Repair complete (${txHashes.length} tx).`);
  if (output.mode === 'json') {
    output.result({
      wallet: signerAddress,
      network,
      txHashes,
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function parseBool(value: string, flag: string): boolean {
  const v = value.toLowerCase().trim();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'y') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'n') return false;
  throw new Error(`${flag} must be true|false (got: ${value})`);
}

async function confirm(options: RepairOptions, output: Output): Promise<boolean> {
  if (options.yes) return true;

  if (!process.stdin.isTTY) {
    throw new Error(
      'Non-TTY environment requires explicit confirmation. Re-run with --yes to acknowledge.'
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => {
    rl.question(fmt.cyan('? ') + 'Send these on-chain transactions? [y/N] ', (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });
  void output;
  return answer === 'y' || answer === 'yes';
}
