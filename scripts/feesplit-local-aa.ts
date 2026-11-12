#!/usr/bin/env ts-node
/**
 * Local bundler and paymaster for a rehearsal of the FeeSplitVault soak through smart wallets, on an
 * anvil without a fork: installs EntryPoint v0.6 and the CoinbaseSmartWallet contracts, then serves
 * one endpoint per paymaster name until it is terminated (src/__e2e__/blockchain-runtime/helpers/localAA).
 * It stands in for the hosted providers; it does not exercise their policies or allowlists.
 *
 * Point the soak runner at it with the SDK's own variables, one URL for bundler and paymaster:
 *   CDP_BUNDLER_URL = CDP_PAYMASTER_URL = http://127.0.0.1:<LOCAL_AA_CDP_PORT>
 *   PIMLICO_BUNDLER_URL = PIMLICO_PAYMASTER_URL = http://127.0.0.1:<LOCAL_AA_PIMLICO_PORT>
 *
 * Env:
 *   LOCAL_AA_RPC                                 the anvil
 *   LOCAL_AA_CDP_KEY, LOCAL_AA_PIMLICO_KEY       funded anvil accounts, one per endpoint
 *   LOCAL_AA_CDP_PORT, LOCAL_AA_PIMLICO_PORT     default 14337, 14338
 *
 * Run: npx ts-node scripts/feesplit-local-aa.ts
 */

import { JsonRpcProvider, Wallet } from 'ethers';
import { LocalAA, installAAContracts } from '../src/__e2e__/blockchain-runtime/helpers/localAA';

const ENDPOINTS = [
  { name: 'cdp', key: 'LOCAL_AA_CDP_KEY', port: 'LOCAL_AA_CDP_PORT', defaultPort: 14_337, paymaster: '0x00000000000000000000000000000000000aa001' },
  { name: 'pimlico', key: 'LOCAL_AA_PIMLICO_KEY', port: 'LOCAL_AA_PIMLICO_PORT', defaultPort: 14_338, paymaster: '0x00000000000000000000000000000000000aa002' },
];

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const provider = new JsonRpcProvider(env('LOCAL_AA_RPC'), undefined, { cacheTimeout: -1 });
  await installAAContracts(provider);
  const started: LocalAA[] = [];
  for (const { name, key, port, defaultPort, paymaster } of ENDPOINTS) {
    const endpoint = await LocalAA.start({
      provider,
      bundler: new Wallet(env(key), provider),
      paymaster,
      port: Number(process.env[port] ?? defaultPort),
    });
    started.push(endpoint);
    console.log(JSON.stringify({ name, url: endpoint.url, paymaster: endpoint.paymaster }));
  }
  console.log('ready');
  const stop = (): void => {
    void Promise.all(started.map(endpoint => endpoint.stop())).then(() => {
      provider.destroy();
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
