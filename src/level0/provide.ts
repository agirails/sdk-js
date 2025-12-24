/**
 * provide() - Basic API for service providers
 *
 * The simplest way to provide a service on AGIRAILS.
 * Just write a function, and AGIRAILS handles the rest.
 *
 * @packageDocumentation
 */

import { Agent } from '../level1/Agent';
import { JobHandler } from '../level1/types/Job';
import { ProvideOptions } from '../level1/types/Options';
import { Provider } from './Provider';
import { serviceDirectory } from './ServiceDirectory';

/**
 * Provide a service
 *
 * This is the simplest way to provide a service on AGIRAILS.
 * You provide a service name and a handler function, and AGIRAILS
 * takes care of wallet management, transactions, and payments.
 *
 * @param service - Service name (e.g., 'translation', 'echo')
 * @param handler - Job handler function
 * @param options - Optional configuration
 * @returns Provider interface for lifecycle control
 *
 * @example
 * ```typescript
 * // Simplest example
 * provide('echo', async (job) => {
 *   return job.input;
 * });
 *
 * // With filtering
 * provide('translation', async (job) => {
 *   const { text, from, to } = job.input;
 *   return { translated: await translate(text, from, to) };
 * }, {
 *   filter: { minBudget: 5 },
 *   network: 'testnet'
 * });
 *
 * // With events
 * const provider = provide('image-gen', async (job) => {
 *   return { imageUrl: await generateImage(job.input.prompt) };
 * });
 *
 * provider.on('payment:received', (amount) => {
 *   console.log(`Earned ${amount} USDC!`);
 * });
 * ```
 */
export function provide(
  service: string,
  handler: JobHandler,
  options?: ProvideOptions
): Provider {
  // Create an Agent instance under the hood
  const agent = new Agent({
    name: `Provider:${service}`,
    description: `Auto-generated provider for ${service}`,
    network: options?.network || 'mock',
    wallet: options?.wallet,
    stateDirectory: options?.stateDirectory,
    rpcUrl: options?.rpcUrl,
    behavior: {
      autoAccept: options?.autoAccept ?? true,
    },
  });

  // Register the service with filter options
  agent.provide(
    {
      name: service,
      filter: options?.filter,
    },
    handler
  );

  // Start the agent immediately (async)
  agent.start().then(() => {
    // Register in service directory after agent has started and has an address
    serviceDirectory.register(service, agent.address);
  }).catch((error) => {
    console.error(`Failed to start provider for ${service}:`, error);
  });

  // Return Provider interface (adapter over Agent)
  const provider: Provider = {
    get status() {
      return agent.status as any;
    },

    get address() {
      return agent.address;
    },

    get balance() {
      return agent.balance;
    },

    pause() {
      agent.pause();
    },

    resume() {
      agent.resume();
    },

    async stop() {
      await agent.stop();
      serviceDirectory.unregister(service, agent.address);
    },

    on(event: any, handler: any) {
      agent.on(event, handler);
    },

    get stats() {
      return {
        jobsCompleted: agent.stats.jobsCompleted,
        jobsFailed: agent.stats.jobsFailed,
        totalEarned: agent.stats.totalEarned,
        averageJobTime: agent.stats.averageJobTime,
      };
    },
  };

  return provider;
}
