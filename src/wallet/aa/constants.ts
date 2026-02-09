/**
 * Account Abstraction constants for CoinbaseSmartWallet on Base.
 *
 * EntryPoint v0.6 — CoinbaseSmartWallet hardcodes this version.
 * Factory address is canonical across all Base networks.
 *
 * @module wallet/aa/constants
 */

/** ERC-4337 EntryPoint v0.6 (canonical, all EVM chains) */
export const ENTRYPOINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';

/** CoinbaseSmartWallet factory (canonical, all Base networks) */
export const SMART_WALLET_FACTORY = '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';

/** Default nonce for first Smart Wallet per owner */
export const DEFAULT_WALLET_NONCE = 0n;

/**
 * UserOperation v0.6 struct — 11 unpacked fields.
 * CoinbaseSmartWallet does NOT support v0.7 packed format.
 */
export interface UserOperationV06 {
  sender: string;
  nonce: bigint;
  initCode: string;
  callData: string;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: string;
  signature: string;
}

/**
 * CoinbaseSmartWallet Call struct for executeBatch.
 */
export interface SmartWalletCall {
  target: string;
  value: bigint;
  data: string;
}

/**
 * Gas estimation result from bundler.
 */
export interface GasEstimate {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
}

/**
 * Paymaster sponsorship response.
 */
export interface PaymasterResponse {
  paymasterAndData: string;
}
