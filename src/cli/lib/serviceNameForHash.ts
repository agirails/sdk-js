/**
 * serviceNameForHash — reverse-lookup a service name from its on-chain hash.
 *
 * PRD-event-driven-provider-listening §5.8. Used by `actp agent` to map
 * `tx.serviceHash` (the bytes32 routing key the kernel emits on
 * TransactionCreated) back to one of the provider's configured service
 * names, so the orchestrator's IncomingRequest carries the right value
 * for policy enforcement.
 *
 * Pre-4.0.0 the agent CLI fell back to `policy.services[0] ?? 'default'`
 * whenever it couldn't infer the service name. With hash routing that
 * fallback can quote the wrong service entirely (caller asked for
 * 'translate', policy returned the default 'echo' price). The correct
 * behavior is: hash didn't match any configured service → skip the
 * request and log, never silently fall through.
 *
 * Match formula matches `Agent.provide()` exactly:
 *   `keccak256(toUtf8Bytes(serviceName))` — no `.toLowerCase()`, no trim
 *   here (`actp request` and `runRequest` both trim before hashing, so
 *   the on-chain hash is already from the trimmed form).
 *
 * @module cli/lib/serviceNameForHash
 */

import { keccak256, toUtf8Bytes } from 'ethers';

/**
 * Return the configured service name whose `keccak256(toUtf8Bytes(name))`
 * equals the given on-chain hash, or `undefined` when no service matches.
 *
 * Comparison is case-insensitive on the hex hash (both stored and queried
 * values are normalized to lowercase) but case-sensitive on the service
 * name (since `Agent.provide(name)` and `actp request --service name` both
 * hash the name as-is per PRD §5.11).
 *
 * @param onChainHash - bytes32 hex string from `tx.serviceHash`. May be
 *                     undefined when reading a legacy ABI; treated as a miss.
 * @param services - the provider's configured service list (e.g.
 *                   `policy.services`).
 *
 * @example
 * ```ts
 * const name = serviceNameForHash(tx.serviceHash, ['onboarding', 'translate']);
 * if (!name) {
 *   logger.warn('Unknown service hash, skipping quote', { txId: tx.id });
 *   continue;
 * }
 * ```
 */
export function serviceNameForHash(
  onChainHash: string | undefined,
  services: readonly string[]
): string | undefined {
  if (!onChainHash) return undefined;
  const target = onChainHash.toLowerCase();
  for (const name of services) {
    if (keccak256(toUtf8Bytes(name)).toLowerCase() === target) return name;
  }
  return undefined;
}
