/**
 * MockUSDC funding helper for the anvil-fork e2e suite (PRD §8.2).
 *
 * Base Sepolia uses a `MockUSDC` deployment whose `mint(address,uint256)`
 * is callable by any address (testnet convention). On an anvil fork we
 * just call `mint` from one of the suite's HD-derived wallets to top up
 * the requester before each test that needs USDC.
 *
 * If MockUSDC's mint is ever locked down (e.g. owner-only), switch to
 * `anvil_setStorageAt` against the ERC-20 balance slot — outside the
 * scope of v1, but the path is well-known.
 *
 * @module __e2e__/blockchain-runtime/helpers/usdc
 */

import { Contract, type Signer } from 'ethers';
import { getNetwork } from '../../../config/networks';

/** Minimal MockUSDC ABI — just the surface the e2e suite touches. */
const MOCK_USDC_ABI = [
  'function mint(address to, uint256 amount) external',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
] as const;

/**
 * Mint USDC to a recipient. Amount is in **base units** (6 decimals), so
 * `mintUsdc(signer, addr, 50_000n)` mints $0.05 USDC.
 *
 * @param signer - Any funded signer (ETH for gas). Doesn't need to be
 *                 the recipient or have mint privileges; MockUSDC is
 *                 open mint on Base Sepolia.
 * @param recipient - Address that ends up with the tokens.
 * @param amountBaseUnits - Amount in 6-decimal base units.
 */
export async function mintUsdc(
  signer: Signer,
  recipient: string,
  amountBaseUnits: bigint
): Promise<void> {
  const cfg = getNetwork('base-sepolia');
  const usdc = new Contract(cfg.contracts.usdc, MOCK_USDC_ABI, signer);
  const tx = await usdc.mint(recipient, amountBaseUnits);
  await tx.wait();
}

/** Convenience: read a recipient's USDC balance in base units. */
export async function usdcBalanceOf(signer: Signer, address: string): Promise<bigint> {
  const cfg = getNetwork('base-sepolia');
  const usdc = new Contract(cfg.contracts.usdc, MOCK_USDC_ABI, signer);
  return usdc.balanceOf(address);
}

/** $X (decimal) → 6-decimal base units. e.g. `usdc('0.05')` → 50_000n. */
export function usdc(decimal: string): bigint {
  const parts = decimal.split('.');
  if (parts.length > 2) throw new Error(`Invalid USDC amount: ${decimal}`);
  const whole = BigInt(parts[0]) * 1_000_000n;
  const fraction = parts[1] ? BigInt(parts[1].slice(0, 6).padEnd(6, '0')) : 0n;
  return whole + fraction;
}
