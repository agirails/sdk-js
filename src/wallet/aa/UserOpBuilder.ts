/**
 * UserOpBuilder — Constructs ERC-4337 v0.6 UserOperations.
 *
 * Builds UserOps for CoinbaseSmartWallet:
 * - Encodes executeBatch(Call[]) as callData
 * - Adds initCode for first-time wallet deployment
 * - Signs with owner's private key (EIP-191 over UserOp hash)
 *
 * Uses ethers v6 for ABI encoding (no viem dependency yet — see Phase 2 note).
 * viem+permissionless will be added if needed for paymaster integration.
 *
 * @module wallet/aa/UserOpBuilder
 */

import { ethers } from 'ethers';
import {
  UserOperationV06,
  SmartWalletCall,
  ENTRYPOINT_V06,
  SMART_WALLET_FACTORY,
  DEFAULT_WALLET_NONCE,
} from './constants';

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

// ============================================================================
// ABI fragments
// ============================================================================

/** CoinbaseSmartWallet.executeBatch(Call[]) */
const EXECUTE_BATCH_ABI = [
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
];

/** CoinbaseSmartWalletFactory.createAccount(bytes[],uint256) */
const FACTORY_CREATE_ABI = [
  'function createAccount(bytes[] owners, uint256 nonce)',
];

/** CoinbaseSmartWalletFactory.getAddress(bytes[],uint256) */
const FACTORY_GET_ADDRESS_ABI = [
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
];

// Typed factory interface to avoid ethers v6 getAddress() collision
const FACTORY_ABI = [
  ...FACTORY_CREATE_ABI,
  ...FACTORY_GET_ADDRESS_ABI,
];

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute the counterfactual Smart Wallet address for a given signer.
 *
 * This address is deterministic (CREATE2) and can be computed off-chain
 * without deploying the wallet.
 */
export async function computeSmartWalletAddress(
  signerAddress: string,
  provider: ethers.JsonRpcProvider,
  nonce: bigint = DEFAULT_WALLET_NONCE
): Promise<string> {
  const factory = new ethers.Contract(
    SMART_WALLET_FACTORY,
    FACTORY_ABI,
    provider
  );
  // CoinbaseSmartWallet encodes owners as bytes[] — EOA address is abi.encode(address)
  const ownerBytes = abiCoder.encode(['address'], [signerAddress]);
  // Use getFunction to avoid collision with ethers v6 BaseContract.getAddress()
  const fn = factory.getFunction('getAddress');
  return await fn([ownerBytes], nonce);
}

/**
 * Build initCode for first-time wallet deployment.
 *
 * initCode = factory address + createAccount calldata
 * When the wallet already exists, pass '0x' as initCode.
 */
export function buildInitCode(
  signerAddress: string,
  nonce: bigint = DEFAULT_WALLET_NONCE
): string {
  const iface = new ethers.Interface(FACTORY_CREATE_ABI);
  const ownerBytes = abiCoder.encode(['address'], [signerAddress]);
  const calldata = iface.encodeFunctionData('createAccount', [
    [ownerBytes],
    nonce,
  ]);
  // initCode = factory address (20 bytes) + calldata
  return SMART_WALLET_FACTORY + calldata.slice(2);
}

/**
 * Encode executeBatch calldata from an array of calls.
 */
export function encodeExecuteBatch(calls: SmartWalletCall[]): string {
  const iface = new ethers.Interface(EXECUTE_BATCH_ABI);
  return iface.encodeFunctionData('executeBatch', [
    calls.map((c) => ({
      target: c.target,
      value: c.value,
      data: c.data,
    })),
  ]);
}

/**
 * Build a full UserOperation (unsigned).
 *
 * Gas limits and paymasterAndData must be filled by the caller
 * (via BundlerClient.estimateGas and PaymasterClient.sponsor).
 */
export function buildUserOp(params: {
  sender: string;
  nonce: bigint;
  calls: SmartWalletCall[];
  isFirstDeploy: boolean;
  signerAddress: string;
}): UserOperationV06 {
  const callData = encodeExecuteBatch(params.calls);
  const initCode = params.isFirstDeploy
    ? buildInitCode(params.signerAddress)
    : '0x';

  return {
    sender: params.sender,
    nonce: params.nonce,
    initCode,
    callData,
    // Placeholder values — filled by gas estimation
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    paymasterAndData: '0x',
    signature: '0x',
  };
}

/**
 * Compute the UserOperation hash for signing (v0.6).
 *
 * hash = keccak256(abi.encode(
 *   keccak256(pack(userOp)),
 *   entryPoint,
 *   chainId
 * ))
 */
export function getUserOpHash(
  userOp: UserOperationV06,
  chainId: number
): string {
  // Pack all fields except signature
  const packed = abiCoder.encode(
    [
      'address',   // sender
      'uint256',   // nonce
      'bytes32',   // keccak256(initCode)
      'bytes32',   // keccak256(callData)
      'uint256',   // callGasLimit
      'uint256',   // verificationGasLimit
      'uint256',   // preVerificationGas
      'uint256',   // maxFeePerGas
      'uint256',   // maxPriorityFeePerGas
      'bytes32',   // keccak256(paymasterAndData)
    ],
    [
      userOp.sender,
      userOp.nonce,
      ethers.keccak256(userOp.initCode),
      ethers.keccak256(userOp.callData),
      userOp.callGasLimit,
      userOp.verificationGasLimit,
      userOp.preVerificationGas,
      userOp.maxFeePerGas,
      userOp.maxPriorityFeePerGas,
      ethers.keccak256(userOp.paymasterAndData),
    ]
  );

  const packedHash = ethers.keccak256(packed);

  return ethers.keccak256(
    abiCoder.encode(
      ['bytes32', 'address', 'uint256'],
      [packedHash, ENTRYPOINT_V06, chainId]
    )
  );
}

/**
 * Sign a UserOperation with the owner's private key.
 *
 * CoinbaseSmartWallet expects the signature to be:
 *   abi.encode(SignatureWrapper(0, abi.encodePacked(r,s,v)))
 *
 * where ownerIndex=0 for single-owner wallets.
 */
export async function signUserOp(
  userOp: UserOperationV06,
  signer: ethers.Wallet,
  chainId: number
): Promise<string> {
  const hash = getUserOpHash(userOp, chainId);
  // ethers signMessage adds EIP-191 prefix. CoinbaseSmartWallet expects raw ECDSA.
  // We use signingKey.sign() for raw signature over the hash bytes.
  const sig = signer.signingKey.sign(hash);
  // Pack r + s + v
  const rawSig = ethers.concat([sig.r, sig.s, new Uint8Array([sig.v])]);

  // CoinbaseSmartWallet SignatureWrapper: abi.encode(uint256 ownerIndex, bytes signatureData)
  return abiCoder.encode(
    ['uint256', 'bytes'],
    [0, rawSig]
  );
}

/**
 * Serialize UserOp for JSON-RPC (bundler API).
 * Converts bigints to hex strings.
 */
export function serializeUserOp(userOp: UserOperationV06): Record<string, string> {
  return {
    sender: userOp.sender,
    nonce: toHex(userOp.nonce),
    initCode: userOp.initCode,
    callData: userOp.callData,
    callGasLimit: toHex(userOp.callGasLimit),
    verificationGasLimit: toHex(userOp.verificationGasLimit),
    preVerificationGas: toHex(userOp.preVerificationGas),
    maxFeePerGas: toHex(userOp.maxFeePerGas),
    maxPriorityFeePerGas: toHex(userOp.maxPriorityFeePerGas),
    paymasterAndData: userOp.paymasterAndData,
    signature: userOp.signature,
  };
}

function toHex(n: bigint): string {
  return '0x' + n.toString(16);
}
