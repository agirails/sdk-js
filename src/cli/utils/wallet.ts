/**
 * Wallet Utilities — Shared wallet generation and Smart Wallet derivation.
 *
 * Extracted from init.ts for reuse by both `actp init` and `actp publish`.
 *
 * @module cli/utils/wallet
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Output } from './output';

/**
 * Generate a new encrypted wallet keystore.
 *
 * - Creates a random ethers.Wallet
 * - Encrypts with password (from ACTP_KEY_PASSWORD env or interactive prompt)
 * - Saves to `{actpDir}/keystore.json` with 0o600 permissions
 *
 * @param actpDir - Path to .actp directory
 * @param output - CLI output handler
 * @returns The generated wallet's address
 */
export async function generateWallet(actpDir: string, output: Output): Promise<string> {
  const { Wallet } = await import('ethers');

  const wallet = Wallet.createRandom();

  // Get password from env var or interactive prompt
  let password = process.env.ACTP_KEY_PASSWORD;
  if (!password) {
    password = await promptPassword();
  }

  if (!password || password.length < 8) {
    throw new Error(
      'Wallet password required (minimum 8 characters).\n' +
        'Set ACTP_KEY_PASSWORD env var or enter when prompted.'
    );
  }

  // Encrypt with Keystore V3 (scrypt + AES-128-CTR)
  output.info('Encrypting wallet (this takes a few seconds)...');
  const keystore = await wallet.encrypt(password);

  // Save with restrictive permissions
  const keystorePath = path.join(actpDir, 'keystore.json');
  fs.writeFileSync(keystorePath, keystore, { mode: 0o600 });

  output.success('Key securely saved and encrypted');
  output.info(`Address: ${wallet.address}`);
  output.warning('Back up your password — it cannot be recovered.');

  return wallet.address;
}

/**
 * Compute the Smart Wallet address for an EOA signer.
 * Uses CREATE2 counterfactual derivation — no deployment needed.
 *
 * @param eoaAddress - The EOA signer address
 * @param mode - 'testnet' or 'mainnet'
 * @param output - CLI output handler
 * @returns The derived Smart Wallet address
 */
export async function computeSmartWalletInit(
  eoaAddress: string,
  mode: string,
  output: Output
): Promise<string> {
  const { ethers } = await import('ethers');
  const { getNetwork } = await import('../../config/networks');
  const { computeSmartWalletAddress } = await import('../../wallet/aa/UserOpBuilder');

  const network = mode === 'testnet' ? 'base-sepolia' : 'base-mainnet';
  const networkConfig = getNetwork(network);
  const rpcUrl = networkConfig.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  output.info('Computing Smart Wallet address...');
  const smartWalletAddress = await computeSmartWalletAddress(eoaAddress, provider);

  output.success(`Smart Wallet: ${smartWalletAddress}`);

  return smartWalletAddress;
}

/**
 * Interactive password prompt (TTY only).
 * Returns empty string in non-TTY environments (piped/agent mode).
 */
async function promptPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    return '';
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('Enter password for wallet encryption (min 8 chars): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
