/**
 * Local candidate stack for the FeeSplitVault e2e suite: a plain anvil (no fork) reporting the Base
 * Sepolia chain id and mining on submission and every second (the SDK waits for two confirmations), and the contracts deployed from the forge artifacts of an actp-kernel checkout.
 *
 * Prerequisites: the `anvil` binary, and `FEESPLIT_KERNEL_OUT` pointing at the `out/` directory of
 * an actp-kernel tree built with `forge build` (it must contain FeeSplitVault and BlacklistUSDC).
 *
 * @module __e2e__/blockchain-runtime/helpers/feeSplitStack
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AbiCoder, ContractFactory, HDNodeWallet, Interface, JsonRpcProvider, Network, type Signer } from 'ethers';

const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const CHAIN_ID = 84_532;
let nextPort = 18_745;

export const TOKEN_INTERFACE = new Interface([
  'function mint(address to, uint256 amount)',
  'function setBlocked(address account, bool blocked)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

export const KERNEL_CALLS = new Interface([
  'function transitionState(bytes32 transactionId, uint8 newState, bytes proof)',
  'function releaseMilestone(bytes32 transactionId, uint256 amount)',
  'function retryPlatformFee(bytes32 transactionId)',
  'function approveEscrowVault(address vault, bool approved)',
  'function setArchiveTreasury(address treasury)',
]);

export const VAULT_VIEWS = new Interface([
  'function remaining(bytes32 escrowId) view returns (uint256)',
  'function bondBalance(bytes32 escrowId) view returns (uint256)',
]);

export const STATE = { IN_PROGRESS: 3, DELIVERED: 4, SETTLED: 5, DISPUTED: 6, CANCELLED: 7 };

export interface FeeSplitStack {
  provider: JsonRpcProvider;
  admin: HDNodeWallet;
  requester: HDNodeWallet;
  providerAgent: HDNodeWallet;
  integrator: string;
  feeRecipient: string;
  token: string;
  kernel: string;
  plainVault: string;
  feeSplitVault: string;
  archive: string;
  /** Funded development account at a derivation index; 0-6 are taken by the stack. */
  wallet: (index: number) => HDNodeWallet;
  stop: () => void;
}

export function feeSplitStackPrereqs(): string[] {
  const missing: string[] = [];
  const out = process.env.FEESPLIT_KERNEL_OUT;
  if (!out || !fs.existsSync(path.join(out, 'FeeSplitVault.sol', 'FeeSplitVault.json'))) missing.push('FEESPLIT_KERNEL_OUT');
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status !== 0) missing.push('anvil');
  return missing;
}

function artifact(out: string, file: string, name: string): { abi: string; bytecode: string } {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(out, file, `${name}.json`), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('abi' in parsed) || !('bytecode' in parsed)) {
    throw new Error(`${name}: not a forge artifact`);
  }
  const bytecode: unknown = parsed.bytecode;
  if (typeof bytecode !== 'object' || bytecode === null || !('object' in bytecode) || typeof bytecode.object !== 'string') {
    throw new Error(`${name}: artifact has no bytecode`);
  }
  return { abi: JSON.stringify(parsed.abi), bytecode: bytecode.object };
}

async function deploy(out: string, file: string, name: string, signer: Signer, args: unknown[]): Promise<string> {
  const { abi, bytecode } = artifact(out, file, name);
  const contract = await new ContractFactory(new Interface(abi), bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract.getAddress();
}

export async function send(signer: Signer, to: string, iface: Interface, name: string, args: unknown[]): Promise<void> {
  const response = await signer.sendTransaction({ to, data: iface.encodeFunctionData(name, args) });
  await response.wait();
}

export async function read(provider: JsonRpcProvider, to: string, iface: Interface, name: string, args: unknown[]): Promise<bigint> {
  const value: unknown = iface.decodeFunctionResult(name, await provider.call({ to, data: iface.encodeFunctionData(name, args) }))[0];
  if (typeof value !== 'bigint') throw new Error(`${name} did not return an integer`);
  return value;
}

export function balanceOf(stack: FeeSplitStack, account: string): Promise<bigint> {
  return read(stack.provider, stack.token, TOKEN_INTERFACE, 'balanceOf', [account]);
}

/** Proof of DELIVERED: dispute window and result hash. */
export function deliveryProof(disputeWindow: number): string {
  return AbiCoder.defaultAbiCoder().encode(['uint256', 'bytes32'], [disputeWindow, '0x' + '5e'.repeat(32)]);
}

/** Explicit-amount resolution proof for the kernel admin. */
export function resolutionProof(requesterAmount: bigint, providerAmount: bigint): string {
  return AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256', 'bool'], [requesterAmount, providerAmount, true]);
}

async function waitForRpc(provider: JsonRpcProvider, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('anvil exited before it was reachable');
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('anvil did not become reachable');
}

export async function startFeeSplitStack(): Promise<FeeSplitStack> {
  const out = process.env.FEESPLIT_KERNEL_OUT;
  if (!out) throw new Error('FEESPLIT_KERNEL_OUT is not set');
  const port = nextPort++;
  const child = spawn('anvil', ['--port', String(port), '--chain-id', String(CHAIN_ID), '--block-time', '1', '--mixed-mining', '--silent'], { stdio: 'ignore' });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, CHAIN_ID, {
    staticNetwork: Network.from(CHAIN_ID),
    cacheTimeout: -1,
  });
  provider.pollingInterval = 100;
  try {
    await waitForRpc(provider, child);
    const wallet = (index: number): HDNodeWallet =>
      HDNodeWallet.fromPhrase(DEV_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider);
    const admin = wallet(0);
    const feeRecipient = wallet(6).address;

    const token = await deploy(out, 'F17F59_FeeAccounting.t.sol', 'BlacklistUSDC', admin, []);
    const kernel = await deploy(out, 'ACTPKernel.sol', 'ACTPKernel', admin, [
      admin.address,
      admin.address,
      feeRecipient,
      '0x0000000000000000000000000000000000000000',
      token,
      3600,
    ]);
    const plainVault = await deploy(out, 'EscrowVault.sol', 'EscrowVault', admin, [token, kernel]);
    const feeSplitVault = await deploy(out, 'FeeSplitVault.sol', 'FeeSplitVault', admin, [token, kernel]);
    const archive = await deploy(out, 'ArchiveTreasury.sol', 'ArchiveTreasury', admin, [token, kernel, admin.address]);
    await send(admin, kernel, KERNEL_CALLS, 'approveEscrowVault', [plainVault, true]);
    await send(admin, kernel, KERNEL_CALLS, 'approveEscrowVault', [feeSplitVault, true]);
    await send(admin, kernel, KERNEL_CALLS, 'setArchiveTreasury', [archive]);

    return {
      provider,
      admin,
      requester: wallet(1),
      providerAgent: wallet(2),
      integrator: wallet(5).address,
      feeRecipient,
      token,
      kernel,
      plainVault,
      feeSplitVault,
      archive,
      wallet,
      stop: () => {
        provider.destroy();
        child.kill();
      },
    };
  } catch (error) {
    provider.destroy();
    child.kill();
    throw error;
  }
}
