import { webcrypto } from 'crypto';
import { ensureNativeWebCrypto } from './webCrypto';

describe('native Web Crypto compatibility', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else Reflect.deleteProperty(globalThis, 'crypto');
  });

  it('provides Node native Web Crypto when the global is absent', () => {
    Reflect.deleteProperty(globalThis, 'crypto');
    ensureNativeWebCrypto();
    expect(globalThis.crypto).toBe(webcrypto);
    const nonce = new Uint8Array(32);
    expect(globalThis.crypto.getRandomValues(nonce)).toBe(nonce);
    expect(nonce.byteLength).toBe(32);
  });

  it('preserves an existing Web Crypto API', () => {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    ensureNativeWebCrypto();
    expect(Object.getOwnPropertyDescriptor(globalThis, 'crypto')).toEqual(descriptor);
  });
});
