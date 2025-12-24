/**
 * Example: Level 1 API - Agent with Lifecycle
 *
 * This demonstrates the Agent-based API:
 * - Agent registration and lifecycle
 * - Service provision with progress reporting
 * - Event handling
 * - Statistics tracking
 *
 * Run this example:
 * ```
 * ts-node examples/level1-agent.ts
 * ```
 */

import { Agent } from '../src';

async function main() {
  console.log('='.repeat(60));
  console.log('AGIRAILS SDK - Level 1 API Example: Agent Lifecycle');
  console.log('='.repeat(60));
  console.log();

  // ==========================================================================
  // CREATE AGENT
  // ==========================================================================

  console.log('[AGENT] Creating agent...');

  const agent = new Agent({
    name: 'TranslationBot',
    description: 'A simple translation service agent',
    network: 'mock',
    behavior: {
      autoAccept: true,
      concurrency: 5,
    },
    logging: {
      level: 'info',
    },
  });

  console.log(`[AGENT] Agent name: ${agent.name}`);
  console.log(`[AGENT] Network: ${agent.network}`);
  console.log(`[AGENT] Status: ${agent.status}`);
  console.log();

  // ==========================================================================
  // REGISTER SERVICE
  // ==========================================================================

  console.log('[AGENT] Registering translation service...');

  agent.provide('translation', async (job, ctx) => {
    console.log(`[AGENT] Processing job: ${job.id}`);
    console.log(`[AGENT] Input:`, job.input);

    // Simulate translation work with progress reporting
    ctx.progress(0, 'Starting translation...');
    ctx.log.info('Translation started');

    await new Promise((resolve) => setTimeout(resolve, 500));
    ctx.progress(50, 'Translating...');

    await new Promise((resolve) => setTimeout(resolve, 500));
    ctx.progress(100, 'Translation complete!');

    // Mock translation result
    const result = {
      original: job.input.text,
      translated: `[DE] ${job.input.text}`,
      from: job.input.from || 'en',
      to: job.input.to || 'de',
    };

    ctx.log.info('Translation completed successfully', result);
    return result;
  });

  console.log(`[AGENT] Services registered: ${agent.serviceNames.join(', ')}`);
  console.log();

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  console.log('[AGENT] Registering event listeners...');

  agent.on('started', () => {
    console.log('[AGENT] ✅ Agent started successfully');
  });

  agent.on('stopped', () => {
    console.log('[AGENT] 🛑 Agent stopped');
  });

  agent.on('error', (error) => {
    console.error('[AGENT] ❌ Error:', error.message);
  });

  agent.on('job:received', (job) => {
    console.log(`[AGENT] 📨 Job received: ${job.id}`);
  });

  agent.on('job:completed', (job, result) => {
    console.log(`[AGENT] ✅ Job completed: ${job.id}`);
    console.log(`[AGENT] Result:`, result);
  });

  agent.on('payment:received', (amount) => {
    console.log(`[AGENT] 💰 Payment received: $${amount} USDC`);
  });

  console.log();

  // ==========================================================================
  // START AGENT
  // ==========================================================================

  console.log('[AGENT] Starting agent...');
  await agent.start();

  console.log(`[AGENT] Address: ${agent.address}`);
  console.log(`[AGENT] Status: ${agent.status}`);
  console.log(`[AGENT] Balance: ${agent.balance.usdc} USDC`);
  console.log();

  // Wait for some simulated activity
  console.log('[AGENT] Agent is now running and listening for jobs...');
  console.log('[AGENT] (In real usage, jobs would come from requesters)');
  console.log();

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // ==========================================================================
  // LIFECYCLE OPERATIONS
  // ==========================================================================

  console.log('[AGENT] Testing lifecycle operations...');
  console.log();

  // Pause
  console.log('[AGENT] Pausing agent...');
  agent.pause();
  console.log(`[AGENT] Status: ${agent.status}`);
  console.log();

  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Resume
  console.log('[AGENT] Resuming agent...');
  agent.resume();
  console.log(`[AGENT] Status: ${agent.status}`);
  console.log();

  await new Promise((resolve) => setTimeout(resolve, 1000));

  // ==========================================================================
  // STATISTICS
  // ==========================================================================

  console.log('[AGENT] Agent statistics:');
  console.log(`  - Jobs received: ${agent.stats.jobsReceived}`);
  console.log(`  - Jobs completed: ${agent.stats.jobsCompleted}`);
  console.log(`  - Jobs failed: ${agent.stats.jobsFailed}`);
  console.log(`  - Total earned: $${agent.stats.totalEarned} USDC`);
  console.log(`  - Total spent: $${agent.stats.totalSpent} USDC`);
  console.log(`  - Success rate: ${(agent.stats.successRate * 100).toFixed(2)}%`);
  console.log(`  - Average job time: ${agent.stats.averageJobTime}ms`);
  console.log();

  // ==========================================================================
  // STOP AGENT
  // ==========================================================================

  console.log('[AGENT] Stopping agent...');
  await agent.stop();
  console.log(`[AGENT] Status: ${agent.status}`);
  console.log();

  console.log('✅ Example completed successfully!');
  console.log('='.repeat(60));
}

// Run the example
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
