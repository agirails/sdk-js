import { webcrypto } from 'crypto';

/** Provide the native CSPRNG for x402 on Node 18, preserving existing APIs. */
export function ensureNativeWebCrypto(): void {
  if (typeof globalThis.crypto === 'undefined') {
    Object.defineProperty(globalThis, 'crypto', {
      value: webcrypto,
      configurable: true,
      writable: true,
    });
  }
}
