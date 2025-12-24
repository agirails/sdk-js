/**
 * Echo Requester Example
 *
 * Demonstrates how to request a service using Level 0 API.
 * This requester calls the "echo" service and displays the result.
 *
 * Run with: tsx examples/echo-requester.ts
 */

import { request } from '../src/level0/request';

async function main() {
  console.log('Echo Requester Example\n');

  try {
    console.log('Requesting echo service...');

    const result = await request('echo', {
      input: { message: 'Hello, AGIRAILS!' },
      budget: 1, // $1 USDC
      network: 'mock',
      timeout: 30000, // 30 seconds
      onProgress: (status) => {
        console.log(`Progress: ${status.progress}% - ${status.message} (${status.state})`);
      },
    });

    console.log('\n✅ Service completed successfully!');
    console.log('\nResult:', JSON.stringify(result.result, null, 2));
    console.log('\nTransaction Details:');
    console.log(`  ID: ${result.transaction.id}`);
    console.log(`  Provider: ${result.transaction.provider}`);
    console.log(`  Amount: $${result.transaction.amount}`);
    console.log(`  Fee: $${result.transaction.fee}`);
    console.log(`  Duration: ${result.transaction.duration}ms`);
  } catch (error) {
    console.error('\n❌ Request failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
