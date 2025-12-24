/**
 * Complete Echo Demo
 *
 * Demonstrates the full request-provider flow in a single script.
 * This combines both provider and requester in one process.
 *
 * Run with: tsx examples/run-demo.ts
 */

import { provide } from '../src/level0/provide';
import { request } from '../src/level0/request';

async function main() {
  console.log('='.repeat(60));
  console.log('AGIRAILS Level 0 API - Echo Demo');
  console.log('='.repeat(60));
  console.log();

  // Step 1: Start the provider
  console.log('Step 1: Starting Echo Provider...');
  const provider = provide(
    'echo',
    async (job, ctx) => {
      console.log(`  [Provider] Job received: ${job.id.slice(0, 10)}...`);
      console.log(`  [Provider] Input:`, job.input);

      ctx.progress(50, 'Processing...');
      await new Promise((resolve) => setTimeout(resolve, 500)); // Simulate work

      const result = {
        echo: job.input,
        processed_at: new Date().toISOString(),
      };

      ctx.progress(100, 'Done!');
      return result;
    },
    {
      network: 'mock',
      autoAccept: true,
    }
  );

  // Wait for provider to initialize
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log(`  Provider address: ${provider.address}`);
  console.log(`  Status: ${provider.status}`);
  console.log();

  // Step 2: Request the service
  console.log('Step 2: Requesting Echo Service...');

  try {
    const result = await request('echo', {
      input: {
        message: 'Hello from AGIRAILS!',
        timestamp: Date.now(),
      },
      budget: 5, // $5 USDC
      network: 'mock',
      timeout: 60000, // 60 seconds
      onProgress: (status) => {
        console.log(`  Progress: ${status.progress}% - ${status.message}`);
      },
    });

    console.log();
    console.log('='.repeat(60));
    console.log('SUCCESS! Service completed');
    console.log('='.repeat(60));
    console.log();
    console.log('Result:');
    console.log(JSON.stringify(result.result, null, 2));
    console.log();
    console.log('Transaction Details:');
    console.log(`  ID:       ${result.transaction.id.slice(0, 20)}...`);
    console.log(`  Provider: ${result.transaction.provider.slice(0, 20)}...`);
    console.log(`  Amount:   $${result.transaction.amount}`);
    console.log(`  Fee:      $${result.transaction.fee}`);
    console.log(`  Duration: ${result.transaction.duration}ms`);
    console.log();
    console.log('Provider Stats:');
    console.log(`  Jobs Completed: ${provider.stats.jobsCompleted}`);
    console.log(`  Total Earned:   $${provider.stats.totalEarned}`);
    console.log();
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    console.error('\nFull error:', error);
  } finally {
    // Step 3: Clean up
    console.log('Step 3: Stopping provider...');
    await provider.stop();
    console.log('  Provider stopped');
    console.log();
    console.log('Demo complete!');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
