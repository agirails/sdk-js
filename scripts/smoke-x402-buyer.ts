/**
 * Live x402 buyer smoke against our self-hosted seller endpoint.
 *
 * Target: https://test-x402-seller.vercel.app/api ($0.01 USDC, Base Sepolia)
 *
 * Uses the canonical SDK entry — `client.pay({ to: <url> })` — which routes
 * https:// targets through the X402Adapter automatically.
 *
 * Run: PRIVATE_KEY=0x... npx tsx scripts/smoke-x402-buyer.ts
 */

import { ACTPClient } from '../src/ACTPClient';

const TARGET = 'https://test-x402-seller.vercel.app/api';

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY env var required');

  const client = await ACTPClient.create({
    mode: 'testnet',
    privateKey: pk,
  });

  console.log(`Target: ${TARGET}`);
  console.log(`[1] client.pay → router auto-detects https:// → X402Adapter`);

  const result = await client.pay({
    to: TARGET,
    amount: '0.01', // human-readable; X402Adapter reads actual amount from 402 response
    httpMethod: 'GET',
    metadata: { paymentMethod: 'x402' }, // explicit opt-in (SDK safeguard)
  });

  console.log(`\n[2] result:`);
  console.log(`    success:        ${result.success}`);
  console.log(`    network:        ${result.network}`);
  console.log(`    transactionId:  ${result.txId ?? '(facilitator-settled)'}`);
  console.log(`    body preview:   `, typeof result.responseBody === 'string'
    ? result.responseBody.slice(0, 200)
    : JSON.stringify(result.responseBody)?.slice(0, 200));

  if (!result.success) throw new Error('x402 payment did not succeed');
  console.log('\n==== LIVE x402 BUYER SMOKE PASSED ====');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
