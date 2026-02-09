/**
 * TransactionBatcher — Encodes ACTP multi-call batches.
 *
 * An ACTP payment requires 3 contract calls:
 *   1. USDC.approve(escrowVault, amount)
 *   2. ACTPKernel.createTransaction(provider, requester, amount, deadline, disputeWindow, serviceHash, agentId)
 *   3. ACTPKernel.linkEscrow(txId, escrowVault, escrowId)
 *
 * TransactionBatcher encodes all 3 as SmartWalletCall[] for executeBatch.
 * It pre-computes the txId using the same keccak256 formula as the contract.
 *
 * @module wallet/aa/TransactionBatcher
 */

import { ethers } from 'ethers';
import { SmartWalletCall } from './constants';
import { ServiceDescriptor } from '../../types/agent';

// ============================================================================
// ABI fragments — minimal for encoding only
// ============================================================================

const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount)',
];

const ACTP_KERNEL_ABI = [
  'function createTransaction(address provider, address requester, uint256 amount, uint256 deadline, uint256 disputeWindow, bytes32 serviceHash, uint256 agentId)',
  'function linkEscrow(bytes32 txId, address escrowVault, bytes32 escrowId)',
];

// ============================================================================
// Types
// ============================================================================

export interface ACTPBatchParams {
  /** Provider address */
  provider: string;
  /** Requester address (= Smart Wallet address) */
  requester: string;
  /** Amount in USDC wei (e.g., "1000000" for 1 USDC) */
  amount: string;
  /** Unix timestamp deadline */
  deadline: number;
  /** Dispute window in seconds */
  disputeWindow: number;
  /** Service hash (bytes32) */
  serviceHash: string;
  /** ERC-8004 agent ID (0 if none) */
  agentId: string;
  /** Current ACTP nonce for the requester (from ACTPKernel.requesterNonces) */
  actpNonce: bigint;
  /** Contract addresses */
  contracts: {
    usdc: string;
    actpKernel: string;
    escrowVault: string;
  };
}

export interface ACTPBatchResult {
  /** Encoded SmartWalletCall[] ready for executeBatch */
  calls: SmartWalletCall[];
  /** Pre-computed transaction ID */
  txId: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Pre-compute ACTP transaction ID.
 *
 * Matches ACTPKernel.sol:
 *   transactionId = keccak256(abi.encodePacked(requester, provider, amount, serviceHash, nonce))
 */
export function computeTransactionId(
  requester: string,
  provider: string,
  amount: string,
  serviceHash: string,
  nonce: bigint
): string {
  return ethers.keccak256(
    ethers.solidityPacked(
      ['address', 'address', 'uint256', 'bytes32', 'uint256'],
      [requester, provider, BigInt(amount), serviceHash, nonce]
    )
  );
}

/**
 * Build the 3-call ACTP payment batch.
 *
 * Returns SmartWalletCall[] for executeBatch and the pre-computed txId.
 */
export function buildACTPPayBatch(params: ACTPBatchParams): ACTPBatchResult {
  const amount = BigInt(params.amount);

  // Pre-compute txId
  const txId = computeTransactionId(
    params.requester,
    params.provider,
    params.amount,
    params.serviceHash,
    params.actpNonce
  );

  const erc20Iface = new ethers.Interface(ERC20_APPROVE_ABI);
  const kernelIface = new ethers.Interface(ACTP_KERNEL_ABI);

  // Call 1: USDC.approve(escrowVault, amount)
  const approveData = erc20Iface.encodeFunctionData('approve', [
    params.contracts.escrowVault,
    amount,
  ]);

  // Call 2: ACTPKernel.createTransaction(...)
  const createTxData = kernelIface.encodeFunctionData('createTransaction', [
    params.provider,
    params.requester,
    amount,
    params.deadline,
    params.disputeWindow,
    params.serviceHash,
    BigInt(params.agentId || '0'),
  ]);

  // Call 3: ACTPKernel.linkEscrow(txId, escrowVault, escrowId)
  // escrowId = txId (ACTP standard)
  const linkEscrowData = kernelIface.encodeFunctionData('linkEscrow', [
    txId,
    params.contracts.escrowVault,
    txId,
  ]);

  const calls: SmartWalletCall[] = [
    { target: params.contracts.usdc, value: 0n, data: approveData },
    { target: params.contracts.actpKernel, value: 0n, data: createTxData },
    { target: params.contracts.actpKernel, value: 0n, data: linkEscrowData },
  ];

  return { calls, txId };
}

/**
 * ABI fragment for AgentRegistry.registerAgent.
 *
 * Matches IAgentRegistry.sol:
 *   registerAgent(string endpoint, ServiceDescriptor[] serviceDescriptors)
 *
 * ServiceDescriptor = (bytes32, string, string, uint256, uint256, uint256, string)
 */
const AGENT_REGISTRY_ABI = [
  'function registerAgent(string endpoint, (bytes32 serviceTypeHash, string serviceType, string schemaURI, uint256 minPrice, uint256 maxPrice, uint256 avgCompletionTime, string metadataCID)[] serviceDescriptors)',
];

/**
 * Build a register-agent batch for AgentRegistry.
 *
 * Used for bootstrap registration (gasless even before registration — chicken-and-egg).
 *
 * @param agentRegistryAddress - AgentRegistry contract address
 * @param endpoint - Agent webhook / IPFS gateway URL
 * @param serviceDescriptors - At least 1 service descriptor (contract requirement)
 */
export function buildRegisterAgentBatch(
  agentRegistryAddress: string,
  endpoint: string,
  serviceDescriptors: ServiceDescriptor[]
): SmartWalletCall[] {
  if (serviceDescriptors.length === 0) {
    throw new Error('At least one service descriptor is required for registration');
  }

  const iface = new ethers.Interface(AGENT_REGISTRY_ABI);

  // Convert to contract format (bigint fields already correct)
  const descriptors = serviceDescriptors.map(sd => ({
    serviceTypeHash: sd.serviceTypeHash,
    serviceType: sd.serviceType,
    schemaURI: sd.schemaURI,
    minPrice: sd.minPrice,
    maxPrice: sd.maxPrice,
    avgCompletionTime: sd.avgCompletionTime,
    metadataCID: sd.metadataCID,
  }));

  const data = iface.encodeFunctionData('registerAgent', [endpoint, descriptors]);

  return [
    { target: agentRegistryAddress, value: 0n, data },
  ];
}

/**
 * Build a MockUSDC mint call (testnet only).
 */
export function buildTestnetMintBatch(
  mockUsdcAddress: string,
  recipient: string,
  amount: string
): SmartWalletCall[] {
  const iface = new ethers.Interface([
    'function mint(address to, uint256 amount)',
  ]);
  const data = iface.encodeFunctionData('mint', [recipient, BigInt(amount)]);

  return [
    { target: mockUsdcAddress, value: 0n, data },
  ];
}

/**
 * Build a combined register + mint batch for testnet init.
 *
 * Single UserOp: register on AgentRegistry + mint test USDC.
 * Both are bootstrap-allowed (gasless without prior registration).
 */
export function buildTestnetInitBatch(params: {
  agentRegistryAddress: string;
  endpoint: string;
  serviceDescriptors: ServiceDescriptor[];
  mockUsdcAddress: string;
  recipient: string;
  mintAmount: string;
}): SmartWalletCall[] {
  const registerCalls = buildRegisterAgentBatch(
    params.agentRegistryAddress,
    params.endpoint,
    params.serviceDescriptors
  );
  const mintCalls = buildTestnetMintBatch(
    params.mockUsdcAddress,
    params.recipient,
    params.mintAmount
  );
  return [...registerCalls, ...mintCalls];
}
