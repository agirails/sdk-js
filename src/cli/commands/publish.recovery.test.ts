/**
 * Unit tests for slug ownership recovery in `actp publish`.
 *
 * Covers the path where:
 *  - The user's local AGIRAILS.md is missing `agent_id` (typical after a
 *    manual edit / scaffold redo / accidental field deletion)
 *  - The slug is already taken on agirails.app
 *  - The local signer wallet matches the on-chain owner of the slug
 *
 * Without recovery, publish silently auto-renames to `slug-2` and the
 * user accidentally creates a new agent. With recovery, we restore the
 * agent_id and treat it as an update.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Output } from '../utils/output';

/**
 * Stub readline before importing the SUT — `readline` is a Node builtin
 * with non-configurable exports, so jest.spyOn can't replace
 * `createInterface` after-the-fact. jest.mock with a factory is the only
 * portable way to inject the test double.
 *
 * `nextAnswer` is set by each test and replayed via the stubbed prompt.
 */
let nextAnswer = '';
jest.mock('readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (a: string) => void) => cb(nextAnswer),
    close: () => {},
  }),
}));

import { maybeRecoverAgentId } from './publish';

describe('maybeRecoverAgentId', () => {
  let tmpDir: string;
  let mdPath: string;
  // Save/restore isTTY via plain assignment — matches the pattern used by
  // cli.test.ts. Using Object.defineProperty here converts the descriptor
  // (Node's tty stream defines isTTY as a getter) and was triggering a
  // uv_cwd cascade when other tests touched process.stdin afterwards.
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
    mdPath = path.join(tmpDir, 'agent-1.md');
    fs.writeFileSync(
      mdPath,
      `---
name: Agent 1
slug: agent-1
services:
  - type: code-review
    price: "5"
pricing:
  base: 5
---
# body
`,
      'utf-8'
    );
    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    (process.stdin as { isTTY?: boolean }).isTTY = originalIsTTY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws OWNERSHIP_RECOVERY_REQUIRES_TTY in non-TTY environments', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = false;

    const output = new Output('quiet');
    const onRestored = jest.fn();

    await expect(
      maybeRecoverAgentId({
        output,
        slug: 'agent-1',
        ownerAgentId: '4972',
        resolvedPath: mdPath,
        onRestored,
      })
    ).rejects.toThrow(/OWNERSHIP_RECOVERY_REQUIRES_TTY/);

    expect(onRestored).not.toHaveBeenCalled();
    // File must remain unchanged on hard-fail
    expect(fs.readFileSync(mdPath, 'utf-8')).not.toContain('agent_id');
  });

  it('error message tells the user the exact agent_id line to paste', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    const output = new Output('quiet');

    await expect(
      maybeRecoverAgentId({
        output,
        slug: 'agent-1',
        ownerAgentId: '4972',
        resolvedPath: mdPath,
        onRestored: jest.fn(),
      })
    ).rejects.toThrow(/agent_id: "4972"/);
  });

  it('writes agent_id back to AGIRAILS.md and calls onRestored when user accepts (TTY)', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    nextAnswer = 'y';

    const output = new Output('quiet');
    const onRestored = jest.fn();

    const result = await maybeRecoverAgentId({
      output,
      slug: 'agent-1',
      ownerAgentId: '4972',
      resolvedPath: mdPath,
      onRestored,
    });

    expect(result).toBe(true);
    expect(onRestored).toHaveBeenCalledTimes(1);
    const content = fs.readFileSync(mdPath, 'utf-8');
    expect(content).toContain('agent_id');
    expect(content).toContain('4972');
  });

  it('returns false and leaves file untouched when user declines (TTY, "n")', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    nextAnswer = 'n';

    const output = new Output('quiet');
    const onRestored = jest.fn();
    const before = fs.readFileSync(mdPath, 'utf-8');

    const result = await maybeRecoverAgentId({
      output,
      slug: 'agent-1',
      ownerAgentId: '4972',
      resolvedPath: mdPath,
      onRestored,
    });

    expect(result).toBe(false);
    expect(onRestored).not.toHaveBeenCalled();
    expect(fs.readFileSync(mdPath, 'utf-8')).toBe(before);
  });

  it('treats empty input (just Enter) as Yes — the [Y/n] default', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    nextAnswer = '';

    const output = new Output('quiet');
    const onRestored = jest.fn();

    const result = await maybeRecoverAgentId({
      output,
      slug: 'agent-1',
      ownerAgentId: '4972',
      resolvedPath: mdPath,
      onRestored,
    });

    expect(result).toBe(true);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });
});
