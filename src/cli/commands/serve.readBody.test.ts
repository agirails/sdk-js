/**
 * readBody hardening tests — covers the slow-loris + oversize cases.
 *
 * The full `actp serve` CLI is exercised end-to-end elsewhere; this file
 * isolates `readBody` (now exported) so we can drive an IncomingMessage
 * mock without booting the real HTTP server.
 */

import { Readable } from 'stream';
import type { IncomingMessage } from 'http';
import { readBody } from './serve';

/**
 * Build a fake IncomingMessage that emits chunks at controlled timing.
 * IncomingMessage extends Readable; passing a Readable that the consumer
 * subscribes to via `on('data', ...)` is sufficient for readBody.
 */
function makeReq(chunks: Array<{ delayMs: number; data: Buffer | null }>): IncomingMessage {
  const stream = new Readable({ read() { /* push driven below */ } });
  // schedule pushes
  let pending = chunks.length;
  for (const c of chunks) {
    setTimeout(() => {
      if (c.data === null) {
        stream.push(null); // EOF
      } else {
        stream.push(c.data);
      }
      if (--pending === 0) {
        // ensure terminal EOF if last entry wasn't null
        const last = chunks[chunks.length - 1];
        if (last.data !== null) stream.push(null);
      }
    }, c.delayMs);
  }
  // Add a no-op destroy compatible with what readBody calls.
  (stream as unknown as { destroy: () => void }).destroy = () => stream.emit('close');
  return stream as unknown as IncomingMessage;
}

describe('readBody', () => {
  it('resolves a normal small body', async () => {
    const req = makeReq([{ delayMs: 0, data: Buffer.from('{"hello":"world"}') }, { delayMs: 5, data: null }]);
    await expect(readBody(req)).resolves.toBe('{"hello":"world"}');
  });

  it('rejects when total bytes exceed the 64 KiB cap', async () => {
    // Two 40 KiB chunks → 80 KiB total → must reject after the second.
    const big = Buffer.alloc(40 * 1024, 0x61);
    const req = makeReq([
      { delayMs: 0, data: big },
      { delayMs: 5, data: big },
      { delayMs: 10, data: null },
    ]);
    await expect(readBody(req)).rejects.toThrow(/Body too large/);
  });

  it('rejects with timeout when the client trickles bytes past the 10s deadline', async () => {
    // Use jest fake timers so we don't actually wait 10s in CI.
    jest.useFakeTimers();
    const req = makeReq([
      { delayMs: 0, data: Buffer.from('a') },
      // Next chunk would arrive after the 10s deadline — readBody must
      // reject before it lands.
      { delayMs: 30_000, data: Buffer.from('b') },
      { delayMs: 30_001, data: null },
    ]);
    const promise = readBody(req);
    // Catch rejection eagerly so an unhandled rejection between
    // advancing timers and asserting doesn't crash the worker.
    const settled = promise.then(
      (v) => ({ ok: true as const, v }),
      (err: Error) => ({ ok: false as const, err }),
    );
    // Advance past the 10s deadline.
    jest.advanceTimersByTime(11_000);
    await Promise.resolve(); // let microtasks flush
    jest.useRealTimers();
    await expect(settled).resolves.toMatchObject({ ok: false, err: expect.objectContaining({ message: 'Body read timeout' }) });
  });
});
