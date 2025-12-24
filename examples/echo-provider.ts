/**
 * Echo Provider Example
 *
 * Demonstrates how to create a service provider using Level 0 API.
 * This provider offers a simple "echo" service that returns the input.
 *
 * Run with: tsx examples/echo-provider.ts
 */

import { provide } from '../src/level0/provide';

console.log('Starting Echo Provider...\n');

// Provide echo service
const provider = provide(
  'echo',
  async (job, ctx) => {
    console.log(`[Provider] Received job ${job.id}`);
    console.log(`[Provider] Input:`, job.input);
    console.log(`[Provider] Budget: $${job.budget}`);

    // Simulate processing
    ctx.progress(50, 'Echoing...');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Return the input as result
    const result = {
      echo: job.input,
      timestamp: new Date().toISOString(),
      provider: 'echo-service-v1',
    };

    ctx.progress(100, 'Complete!');
    console.log(`[Provider] Returning result:`, result);

    return result;
  },
  {
    network: 'mock',
    autoAccept: true,
  }
);

// Listen to events
provider.on('payment:received', (amount) => {
  console.log(`\n💰 Payment received: $${amount}`);
});

provider.on('job:completed', (job, result) => {
  console.log(`\n✅ Job completed: ${job.id}`);
});

provider.on('error', (error) => {
  console.error(`\n❌ Error:`, error.message);
});

console.log(`Echo Provider running at: ${provider.address}`);
console.log(`Status: ${provider.status}`);
console.log('\nWaiting for jobs...');
console.log('Press Ctrl+C to stop\n');

// Keep process alive
process.on('SIGINT', async () => {
  console.log('\n\nStopping provider...');
  await provider.stop();
  console.log('Provider stopped. Stats:', provider.stats);
  process.exit(0);
});
