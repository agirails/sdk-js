/**
 * AIP-16 Delivery Surface — Pluggable Channel Logger (Phase 2b)
 * ==============================================================
 *
 * Minimal logger contract used by delivery channel implementations
 * (`MockDeliveryChannel`, `RelayDeliveryChannel`) to surface
 * operational events — transport errors, dedup hits, subscriber-callback
 * errors that were swallowed per security invariant #2 — without
 * coupling those implementations to any specific logging framework.
 *
 * ## Design intent
 *
 * Channels are dumb pipes: they verify nothing, decrypt nothing, and
 * make no business decisions. They DO, however, encounter transport
 * failures, malformed payloads, and (per the subscriber-error-isolation
 * invariant) consumer callbacks that throw. Operators need visibility
 * into these events; tests need to be able to assert on or silence
 * them. A pluggable {@link LogFn} satisfies both needs without
 * pulling pino/winston/console into the SDK runtime.
 *
 * The shape is intentionally minimal — three levels, a message string,
 * and an optional structured `details` bag. Implementers can adapt
 * this to any backend (console, pino, OpenTelemetry, in-memory buffer
 * for tests, etc.).
 *
 * ## Levels
 *
 *  - `"info"`  — Normal lifecycle events (subscription opened/closed,
 *    publish accepted). Quiet by default in production.
 *  - `"warn"`  — Recoverable anomalies (dedup hit on poisoned signature,
 *    subscriber callback threw and was swallowed, optional `getSetups`
 *    not supported by the underlying transport). Worth surfacing in
 *    dashboards but not pageable.
 *  - `"error"` — Transport failures (relay returned 5xx, network
 *    unreachable, malformed wire object rejected before publish).
 *    May trigger retries upstream.
 *
 * ## Default
 *
 * The exported {@link noopLog} is a silent default suitable for
 * library consumers who do not want any logging output. Tests can
 * provide a capturing logger; production deployments can adapt the
 * SDK's events to their preferred observability stack.
 *
 * @example Console logger
 * ```typescript
 * import type { LogFn } from '@agirails/sdk/delivery';
 *
 * const consoleLog: LogFn = (level, msg, details) => {
 *   // eslint-disable-next-line no-console
 *   console[level](`[delivery] ${msg}`, details ?? {});
 * };
 * ```
 *
 * @example Capturing logger for tests
 * ```typescript
 * const events: Array<{ level: string; msg: string; details?: unknown }> = [];
 * const captureLog: LogFn = (level, msg, details) => {
 *   events.push({ level, msg, details });
 * };
 * // …run channel under test, then assert on `events`.
 * ```
 *
 * @module delivery/channelLog
 */

// ============================================================================
// Logger function shape
// ============================================================================

/**
 * Pluggable logger function used by delivery channel implementations.
 *
 * Implementations of this signature receive a level, a human-readable
 * message string, and an optional structured `details` bag. They MAY
 * route the event to any backend (console, pino, OTel, in-memory
 * capture, /dev/null) — the channel does not care.
 *
 * The function MUST be synchronous from the channel's point of view
 * (the channel never `await`s it). Implementations that need to batch
 * or ship logs asynchronously SHOULD do so via internal queues, NOT
 * by returning a Promise.
 *
 * Implementations MUST NOT throw. If an underlying logging backend
 * fails (e.g. write to disk failed), implementations SHOULD catch
 * and discard — a channel cannot let a logging failure interrupt
 * delivery transport.
 *
 * @param level The severity of the event. See module JSDoc for level
 *   semantics.
 * @param msg A human-readable description of the event. Stable enough
 *   to be greppable across log volumes, but not promised as a
 *   machine-actionable identifier — use `details.code` (when present)
 *   for that.
 * @param details Optional structured context (txId, signer address,
 *   HTTP status, error code, etc.). Implementations SHOULD attach
 *   any details bag to the underlying log record verbatim; loggers
 *   that flatten structured data SHOULD preserve key/value pairs.
 */
export type LogFn = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  details?: Record<string, unknown>,
) => void;

// ============================================================================
// Default silent logger
// ============================================================================

/**
 * Silent default {@link LogFn}: discards every event.
 *
 * Suitable as the default `log` parameter on channel constructors so
 * that consumers who do not opt into logging see no output. Tests and
 * production deployments that want visibility SHOULD pass their own
 * {@link LogFn} implementation.
 *
 * @example
 * ```typescript
 * import { noopLog } from '@agirails/sdk/delivery';
 *
 * const channel = new RelayDeliveryChannel({
 *   baseUrl: 'https://relay.agirails.io',
 *   log: noopLog, // explicit silence; same as omitting the param
 * });
 * ```
 */
export const noopLog: LogFn = () => {
  // Intentional no-op. See JSDoc for rationale.
};
