/**
 * Example: Level 0 API - Echo Service
 *
 * This demonstrates the simplest possible AGIRAILS usage:
 * - Provider: Registers an echo service that returns input
 * - Requester: Requests the echo service
 *
 * Run this example:
 * ```
 * ts-node examples/level0-echo.ts
 * ```
 */

import { provide, request } from '../src';

async function main() {
  console.log('='.repeat(60));
  console.log('AGIRAILS SDK - Level 0 API Example: Echo Service');
  console.log('='.repeat(60));
  console.log();

  // ==========================================================================
  // PROVIDER SIDE
  // ==========================================================================

  console.log('[PROVIDER] Starting echo service provider...');

  const provider = provide('echo', async (job) => {
    console.log(`[PROVIDER] Received job: ${job.id}`);
    console.log(`[PROVIDER] Input:`, job.input);
    console.log(`[PROVIDER] Budget: $${job.budget} USDC`);

    // Simple echo: return the input
    return { echoed: job.input };
  }, {
    network: 'mock', // Run in mock mode (no blockchain needed)
  });

  // Listen to events
  provider.on('job:received', (job) => {
    console.log(`[PROVIDER] Job received event: ${job.id}`);
  });

  provider.on('job:completed', (job, result) => {
    console.log(`[PROVIDER] Job completed event: ${job.id}`);
    console.log(`[PROVIDER] Result:`, result);
  });

  provider.on('payment:received', (amount) => {
    console.log(`[PROVIDER] Payment received: $${amount} USDC`);
  });

  console.log(`[PROVIDER] Provider address: ${provider.address}`);
  console.log(`[PROVIDER] Provider status: ${provider.status}`);
  console.log();

  // Wait a bit for provider to start
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // ==========================================================================
  // REQUESTER SIDE
  // ==========================================================================

  console.log('[REQUESTER] Requesting echo service...');

  try {
    const { result, transaction } = await request('echo', {
      input: 'Hello, AGIRAILS!',
      budget: 1, // $1 USDC
      network: 'mock',
      onProgress: (status) => {
        console.log(`[REQUESTER] Progress: ${status.state} (${status.progress || 0}%)`);
      },
    });

    console.log();
    console.log('[REQUESTER] Request completed!');
    console.log('[REQUESTER] Result:', result);
    console.log('[REQUESTER] Transaction ID:', transaction.id);
    console.log('[REQUESTER] Provider:', transaction.provider);
    console.log('[REQUESTER] Amount paid:', transaction.amount);
    console.log('[REQUESTER] Platform fee:', transaction.fee);
    console.log('[REQUESTER] Duration:', transaction.duration, 'ms');
    console.log();

    // Check provider stats
    console.log('[PROVIDER] Final statistics:');
    console.log(`  - Jobs completed: ${provider.stats.jobsCompleted}`);
    console.log(`  - Jobs failed: ${provider.stats.jobsFailed}`);
    console.log(`  - Total earned: $${provider.stats.totalEarned} USDC`);
    console.log(`  - Average job time: ${provider.stats.averageJobTime}ms`);
    console.log();

    console.log('✅ Example completed successfully!');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    // Cleanup
    console.log();
    console.log('[PROVIDER] Stopping provider...');
    await provider.stop();
    console.log('[PROVIDER] Provider stopped');
  }

  console.log();
  console.log('='.repeat(60));
}

// Run the example
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
