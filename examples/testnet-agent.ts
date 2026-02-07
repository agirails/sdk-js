/**
 * Example: Testnet Agent with Keystore Auto-Detect
 *
 * Demonstrates the seamless keystore flow on Base Sepolia:
 *   1. `actp init -m testnet` generates an encrypted keystore
 *   2. This agent loads it automatically via ACTP_KEY_PASSWORD
 *
 * Setup:
 * ```
 * ACTP_KEY_PASSWORD=your-password actp init -m testnet
 * ```
 *
 * Run:
 * ```
 * ACTP_KEY_PASSWORD=your-password ts-node examples/testnet-agent.ts
 * ```
 *
 * The agent resolves its wallet automatically:
 *   - ACTP_PRIVATE_KEY env var (if set, takes priority)
 *   - .actp/keystore.json decrypted with ACTP_KEY_PASSWORD
 *   - Clear error if neither is available
 */

import { Agent } from '../src';

async function main() {
  console.log('='.repeat(60));
  console.log('AGIRAILS SDK - Testnet Agent (Base Sepolia)');
  console.log('='.repeat(60));
  console.log();

  const agent = new Agent({
    name: 'TestnetEcho',
    description: 'Echo service on Base Sepolia testnet',
    network: 'testnet',
    behavior: {
      autoAccept: true,
      concurrency: 5,
    },
  });

  agent.provide('echo', async (job, ctx) => {
    ctx.progress(50, 'Processing...');
    return { echoed: job.input, network: 'testnet' };
  });

  agent.on('started', () => {
    console.log(`Agent running on testnet`);
    console.log(`Address: ${agent.address}`);
  });

  agent.on('job:completed', (_job, result) => {
    console.log('Job completed:', result);
  });

  agent.on('payment:received', (data) => {
    console.log(`Earned ${data.amount} USDC`);
  });

  agent.on('error', (error) => {
    console.error('Agent error:', error.message);
  });

  await agent.start();

  // Keep running until interrupted
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await agent.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal:', error.message);
  process.exit(1);
});
