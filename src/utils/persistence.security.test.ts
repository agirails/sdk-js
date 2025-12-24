import * as fs from 'fs';
import * as path from 'path';

import { MockStateManager } from '../runtime/MockStateManager';
import { FileBasedNonceManager } from './NonceManager';
import { FileBasedUsedAttestationTracker } from './UsedAttestationTracker';

function mkTmpDir(prefix: string): string {
  // Keep temp dirs inside the repo so the sandbox always allows writes.
  return fs.mkdtempSync(path.join(process.cwd(), prefix));
}

describe('Persistence hardening (symlink safety + first-write correctness)', () => {
  test('MockStateManager refuses symlinked .actp directory', () => {
    const tmp = mkTmpDir('.tmp-actp-');
    const base = path.join(tmp, 'base');
    const real = path.join(tmp, 'real-actp');

    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(real, { recursive: true });

    fs.symlinkSync(real, path.join(base, '.actp'), 'dir');

    expect(() => new MockStateManager(base)).toThrow('symlink');
  });

  test('FileBasedNonceManager refuses symlinked .actp directory', () => {
    const tmp = mkTmpDir('.tmp-nonces-');
    const base = path.join(tmp, 'base');
    const real = path.join(tmp, 'real-actp');

    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(real, { recursive: true });

    fs.symlinkSync(real, path.join(base, '.actp'), 'dir');

    expect(() => new FileBasedNonceManager(base)).toThrow('symlink');
  });

  test('FileBasedUsedAttestationTracker refuses symlinked .actp directory', () => {
    const tmp = mkTmpDir('.tmp-attestations-');
    const base = path.join(tmp, 'base');
    const real = path.join(tmp, 'real-actp');

    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(real, { recursive: true });

    fs.symlinkSync(real, path.join(base, '.actp'), 'dir');

    expect(() => new FileBasedUsedAttestationTracker(base)).toThrow('symlink');
  });

  test('FileBasedNonceManager can persist on first write (creates file before locking)', async () => {
    const tmp = mkTmpDir('.tmp-nonce-write-');
    const base = path.join(tmp, 'base');
    fs.mkdirSync(base, { recursive: true });

    const mgr = new FileBasedNonceManager(base);

    const n1 = await mgr.getAndIncrementNonce('agirails.delivery.v1');
    const n2 = await mgr.getAndIncrementNonce('agirails.delivery.v1');

    expect(n1).toBe(1);
    expect(n2).toBe(2);

    const nonceFile = path.join(base, '.actp', 'nonces.json');
    expect(fs.existsSync(nonceFile)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(nonceFile, 'utf-8'));
    expect(parsed['agirails.delivery.v1']).toBe(2);
  });
});






