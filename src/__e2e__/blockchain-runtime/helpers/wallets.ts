/**
 * HD wallet derivation for the anvil-fork e2e suite (PRD §8.2).
 *
 * One BIP-39 mnemonic backs the whole suite (`CI_TEST_KEYSTORE_BASE64`).
 * Each test slot derives an ephemeral child wallet at a deterministic
 * path — `m/44'/60'/0'/0/{slot}` — so tests don't fight over nonces and
 * can run in parallel within a single anvil instance.
 *
 * Test slot allocation (low single digits keeps derivation cheap; bump
 * the cap if a new case needs more):
 *   0 — provider for happy-path scenarios
 *   1 — requester for happy-path scenarios
 *   2 — second provider (multi-handler tests)
 *   3 — second requester (concurrent scenarios)
 *   4 — third requester (concurrent scenarios)
 *   5+ — reserved for future tests
 *
 * Anvil's `--fork-url` flag inherits Base Sepolia state at the pinned
 * block, INCLUDING the dev-funded mnemonic's wallet balances. The
 * suite's funding model: each child wallet gets a small ETH top-up
 * via `anvil_setBalance` and USDC via `MockUSDC.mint` (see usdc.ts).
 *
 * @module __e2e__/blockchain-runtime/helpers/wallets
 */

import { HDNodeWallet, Mnemonic, Wallet, JsonRpcProvider } from 'ethers';
import type { AnvilHandle } from './anvil';

/** Default funding for each derived wallet: 1 ETH. Enough for hundreds of TXs. */
const DEFAULT_FUND_WEI = 1_000_000_000_000_000_000n; // 1 ETH

/**
 * Decode the base64 mnemonic + return ethers' HDNodeWallet root.
 * Throws if the env var is missing or contains an invalid mnemonic.
 *
 * ethers v6 quirk: `HDNodeWallet.fromMnemonic(m)` with no path argument
 * does NOT return the root — it defaults to `m/44'/60'/0'/0/0` (depth 5).
 * From a deep node, `derivePath('m/...')` rejects absolute paths. We
 * explicitly pass `'m'` to anchor the returned wallet at depth 0 so
 * `deriveSlotWallet` below can use the full `m/44'/60'/0'/0/<slot>` path.
 */
export function loadTestMnemonic(): HDNodeWallet {
  const b64 = process.env.CI_TEST_KEYSTORE_BASE64;
  if (!b64) {
    throw new Error(
      'loadTestMnemonic: CI_TEST_KEYSTORE_BASE64 env var is not set. ' +
      'Set it to base64(your BIP-39 mnemonic) for the e2e suite to run.'
    );
  }
  const phrase = Buffer.from(b64, 'base64').toString('utf-8').trim();
  const mnemonic = Mnemonic.fromPhrase(phrase);
  return HDNodeWallet.fromMnemonic(mnemonic, 'm');
}

/**
 * Derive an ephemeral wallet at the suite-reserved slot and connect it
 * to the anvil provider. Idempotent — same slot always returns the same
 * address — so tests can re-derive without coordination.
 */
export function deriveSlotWallet(slot: number, provider: JsonRpcProvider): Wallet {
  const root = loadTestMnemonic();
  // Standard m/44'/60'/0'/0/<slot> path.
  const child = root.derivePath(`m/44'/60'/0'/0/${slot}`);
  return new Wallet(child.privateKey, provider);
}

/**
 * Pre-fund a derived wallet with ETH via `anvil_setBalance`. This is the
 * cheapest funding path (no on-chain TX, no parent-wallet drain) and
 * works on every anvil instance. USDC funding lives in usdc.ts.
 *
 * @param wei - Amount in wei. Defaults to 1 ETH.
 */
export async function fundWalletEth(
  anvil: AnvilHandle,
  address: string,
  wei: bigint = DEFAULT_FUND_WEI
): Promise<void> {
  // anvil_setBalance accepts hex-quantity per Ethereum JSON-RPC spec.
  await anvil.rpc('anvil_setBalance', [address, '0x' + wei.toString(16)]);
}

/**
 * Convenience: derive + fund in one call. Returns the wallet ready for
 * createTransaction / linkEscrow / etc.
 */
export async function provisionSlot(
  anvil: AnvilHandle,
  slot: number,
  fundingWei: bigint = DEFAULT_FUND_WEI
): Promise<Wallet> {
  const wallet = deriveSlotWallet(slot, anvil.provider);
  await fundWalletEth(anvil, wallet.address, fundingWei);
  return wallet;
}
