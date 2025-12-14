#!/usr/bin/env npx ts-node
/**
 * Derive Provider Address from Private Key
 *
 * Usage: npx ts-node scripts/derive-provider-address.ts
 *
 * Reads ACTP_PROVIDER_PRIVATE_KEY from environment (or .env.test)
 * and prints ONLY the derived address - never the key.
 */

import { config } from 'dotenv';
import { Wallet } from 'ethers';
import * as path from 'path';

// Load .env.test if present
config({ path: path.resolve(__dirname, '../.env.test') });

// Also load from parent .env if needed
config({ path: path.resolve(__dirname, '../.env') });

const providerKey = process.env.ACTP_PROVIDER_PRIVATE_KEY;

if (!providerKey || providerKey === '0xPASTE_PROVIDER_PRIVATE_KEY_HERE') {
  console.error('ERROR: ACTP_PROVIDER_PRIVATE_KEY not set or still placeholder');
  console.error('Copy .env.test.example to .env.test and paste the provider private key');
  process.exit(1);
}

try {
  const wallet = new Wallet(providerKey);
  console.log(`Derived provider address: ${wallet.address}`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: Invalid private key format - ${message}`);
  process.exit(1);
}
