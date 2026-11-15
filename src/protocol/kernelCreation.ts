import { Interface, ZeroHash } from 'ethers';
import canonicalAbi from '../abi/ACTPKernel.json';

const LEGACY_KERNEL = '0x048c811352e8a3fecd5b0ec4aa2c2b94083cc842';
const LEGACY_CREATE = 'function createTransaction(address provider,address requester,uint256 amount,uint256 deadline,uint256 disputeWindow,bytes32 serviceHash,uint256 agentId,uint256 requesterAgentId) returns (bytes32)';
const LEGACY_CREATED = 'event TransactionCreated(bytes32 indexed transactionId,address indexed requester,address indexed provider,uint256 amount,bytes32 serviceHash,uint256 deadline,uint256 timestamp,uint256 agentId)';

/** Locally pinned legacy deployment descriptor; no network capability claim. */
export function isLegacyCreationKernel(address: string): boolean {
  return address.toLowerCase() === LEGACY_KERNEL;
}

/** Preserve the configured legacy writer/event ABI and candidate-v2 elsewhere. */
export function kernelCreationInterface(address: string): Interface {
  if (!isLegacyCreationKernel(address)) return new Interface(canonicalAbi);
  return new Interface([
    ...canonicalAbi.filter(item => item.name !== 'createTransaction' && item.name !== 'TransactionCreated'),
    LEGACY_CREATE, LEGACY_CREATED,
  ]);
}

/** Drop the v2 binding only when it is explicitly absent on a legacy write. */
export function kernelCreationArguments(address: string, args: unknown[], agreementHash: string): unknown[] {
  if (args.length !== 9) throw new Error('Expected canonical nine creation arguments');
  if (!isLegacyCreationKernel(address)) return args;
  if (agreementHash.toLowerCase() !== ZeroHash) throw new Error('Legacy kernel does not support agreementHash; refusing to discard binding');
  return args.filter((_arg, index) => index !== 6);
}
