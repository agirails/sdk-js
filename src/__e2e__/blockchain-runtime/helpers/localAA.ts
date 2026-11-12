/**
 * Local stand-in for an ERC-4337 bundler and an ERC-7677 paymaster, for an anvil without a fork.
 *
 * `installAAContracts` puts the deployed code of EntryPoint v0.6 and of the CoinbaseSmartWallet
 * factory, implementation and SenderCreator (read from Base Sepolia, `aaContracts.json`) at their
 * canonical addresses, so UserOps are validated and executed by the real contracts. `LocalAA` then
 * serves the JSON-RPC methods the SDK calls: it sponsors every UserOp from a paymaster that accepts
 * everything and whose EntryPoint deposit pays the gas, and it bundles by calling `handleOps` from
 * its own funded account.
 *
 * What it proves: the UserOps the SDK builds, signs and submits pass the real EntryPoint and smart
 * wallet with a paymaster paying. What it cannot prove: that a hosted paymaster's policy or
 * allowlist accepts the same calls.
 *
 * @module __e2e__/blockchain-runtime/helpers/localAA
 */

import * as http from 'http';
import { Interface, getAddress, toBeHex, type JsonRpcProvider, type Signer } from 'ethers';
import contracts from './aaContracts.json';

const USER_OP =
  '(address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,' +
  'uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)';
const USER_OP_FIELDS = [
  'sender',
  'nonce',
  'initCode',
  'callData',
  'callGasLimit',
  'verificationGasLimit',
  'preVerificationGas',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'paymasterAndData',
  'signature',
];
const ACCEPT_ALL_PAYMASTER = '0x604060005260606000f3';
const HANDLE_OPS_GAS = 8_000_000n;
const GAS_ESTIMATE = { callGasLimit: toBeHex(3_000_000), verificationGasLimit: toBeHex(1_000_000), preVerificationGas: toBeHex(100_000) };

export const ENTRY_POINT = contracts.entryPoint.address;

export const ENTRY_POINT_INTERFACE = new Interface([
  `function handleOps(${USER_OP}[] ops, address beneficiary)`,
  `function getUserOpHash(${USER_OP} op) view returns (bytes32)`,
  'function depositTo(address account) payable',
  'function balanceOf(address account) view returns (uint256)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'error FailedOp(uint256 opIndex, string reason)',
]);

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: string
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function revertData(error: unknown): string | undefined {
  return isRecord(error) && typeof error.data === 'string' ? error.data : undefined;
}

function userOpTuple(value: unknown): string[] {
  if (!isRecord(value)) throw new RpcError(-32602, 'UserOperation is not an object');
  return USER_OP_FIELDS.map(name => {
    const field = value[name];
    if (typeof field !== 'string') throw new RpcError(-32602, `UserOperation.${name} is missing`);
    return field;
  });
}

/** Puts EntryPoint v0.6 and the CoinbaseSmartWallet contracts at their canonical addresses. */
export async function installAAContracts(provider: JsonRpcProvider): Promise<void> {
  for (const { address, code } of Object.values(contracts)) {
    await provider.send('anvil_setCode', [address, code]);
  }
}

/** The paymaster named by the UserOperationEvent of `sender` in a mined transaction. */
export async function sponsorOf(provider: JsonRpcProvider, txHash: string, sender: string): Promise<string> {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`no receipt for ${txHash}`);
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(ENTRY_POINT)) continue;
    const parsed = ENTRY_POINT_INTERFACE.parseLog(log);
    if (parsed?.name !== 'UserOperationEvent') continue;
    const [, opSender, paymaster]: unknown[] = parsed.args;
    if (typeof opSender === 'string' && typeof paymaster === 'string' && getAddress(opSender) === getAddress(sender)) {
      return getAddress(paymaster);
    }
  }
  throw new Error(`${txHash} carries no UserOperationEvent of ${sender}`);
}

export interface LocalAAOptions {
  provider: JsonRpcProvider;
  /** Funded account that deposits for the paymaster and sends the bundles; one per endpoint. */
  bundler: Signer;
  /** Address the accept-all paymaster is placed at. */
  paymaster: string;
  port: number;
}

export class LocalAA {
  readonly url: string;
  readonly paymaster: string;
  private readonly submitted = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: LocalAAOptions,
    private readonly server: http.Server
  ) {
    this.url = `http://127.0.0.1:${options.port}`;
    this.paymaster = getAddress(options.paymaster.toLowerCase());
  }

  /** Places and funds the paymaster and starts serving on 127.0.0.1. */
  static async start(options: LocalAAOptions): Promise<LocalAA> {
    const { provider, bundler, port } = options;
    const paymaster = getAddress(options.paymaster.toLowerCase());
    await provider.send('anvil_setCode', [paymaster, ACCEPT_ALL_PAYMASTER]);
    const deposit = await bundler.sendTransaction({
      to: ENTRY_POINT,
      data: ENTRY_POINT_INTERFACE.encodeFunctionData('depositTo', [paymaster]),
      value: 5n * 10n ** 18n,
    });
    await deposit.wait();
    const server = http.createServer();
    const local = new LocalAA(options, server);
    server.on('request', (request, response) => local.serve(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    return local;
  }

  stop(): Promise<void> {
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private serve(request: http.IncomingMessage, response: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void this.answer(Buffer.concat(chunks).toString('utf8')).then(body => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });
  }

  private async answer(body: string): Promise<Record<string, unknown>> {
    let id: unknown = null;
    try {
      const call: unknown = JSON.parse(body);
      if (!isRecord(call) || typeof call.method !== 'string' || !Array.isArray(call.params)) {
        throw new RpcError(-32600, 'not a JSON-RPC request');
      }
      id = call.id;
      return { jsonrpc: '2.0', id, result: await this.dispatch(call.method, call.params) };
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32603;
      const message = error instanceof Error ? error.message : String(error);
      return { jsonrpc: '2.0', id, error: { code, message, data: error instanceof RpcError ? error.data : undefined } };
    }
  }

  private dispatch(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'pm_getPaymasterStubData':
      case 'pm_getPaymasterData':
        return Promise.resolve({ paymasterAndData: this.paymaster.toLowerCase() });
      case 'eth_estimateUserOperationGas':
        return this.estimate(userOpTuple(params[0]));
      case 'eth_sendUserOperation':
        return this.inOrder(() => this.submit(userOpTuple(params[0])));
      case 'eth_getUserOperationReceipt':
        return this.receipt(String(params[0]));
      default:
        throw new RpcError(-32601, `method ${method} is not served`);
    }
  }

  private async inOrder<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async estimate(op: string[]): Promise<unknown> {
    const [sender, , , callData] = op;
    if ((await this.options.provider.getCode(sender)) !== '0x') {
      try {
        await this.options.provider.call({ from: ENTRY_POINT, to: sender, data: callData });
      } catch (error) {
        const data = revertData(error);
        throw new RpcError(-32521, `UserOperation reverted during simulation with reason: ${data ?? 'unknown'}`, data);
      }
    }
    return GAS_ESTIMATE;
  }

  private async submit(op: string[]): Promise<string> {
    const { provider, bundler } = this.options;
    const beneficiary = await bundler.getAddress();
    const hashCall = await provider.call({ to: ENTRY_POINT, data: ENTRY_POINT_INTERFACE.encodeFunctionData('getUserOpHash', [op]) });
    const userOpHash = String(ENTRY_POINT_INTERFACE.decodeFunctionResult('getUserOpHash', hashCall)[0]);
    const data = ENTRY_POINT_INTERFACE.encodeFunctionData('handleOps', [[op], beneficiary]);
    try {
      await provider.call({ from: beneficiary, to: ENTRY_POINT, data, gasLimit: HANDLE_OPS_GAS });
    } catch (error) {
      const reverted = revertData(error);
      const failed = reverted ? ENTRY_POINT_INTERFACE.parseError(reverted) : null;
      throw new RpcError(-32500, failed?.name === 'FailedOp' ? String(failed.args[1]) : 'handleOps reverted', reverted);
    }
    const sent = await bundler.sendTransaction({ to: ENTRY_POINT, data, gasLimit: HANDLE_OPS_GAS });
    this.submitted.set(userOpHash, sent.hash);
    return userOpHash;
  }

  private async receipt(userOpHash: string): Promise<unknown> {
    const txHash = this.submitted.get(userOpHash);
    const mined = txHash ? await this.options.provider.getTransactionReceipt(txHash) : null;
    if (!mined) return null;
    for (const log of mined.logs) {
      const parsed = getAddress(log.address) === getAddress(ENTRY_POINT) ? ENTRY_POINT_INTERFACE.parseLog(log) : null;
      if (parsed?.name !== 'UserOperationEvent') continue;
      const [hash, sender, paymaster, , success]: unknown[] = parsed.args;
      if (hash !== userOpHash) continue;
      return {
        userOpHash,
        sender,
        paymaster,
        success: success === true,
        receipt: { transactionHash: mined.hash, blockNumber: toBeHex(mined.blockNumber), status: '0x1' },
      };
    }
    throw new RpcError(-32603, `bundle ${mined.hash} carries no event of ${userOpHash}`);
  }
}
