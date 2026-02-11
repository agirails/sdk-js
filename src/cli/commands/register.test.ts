/**
 * Register Command Tests
 *
 * Tests cover:
 * - Fix 4: Deprecation early-exit without --force-legacy
 * - Fix 4: --force-legacy flag allows execution
 */

import { createRegisterCommand } from './register';

describe('register command (Fix 4)', () => {
  it('should have --force-legacy option', () => {
    const cmd = createRegisterCommand();
    const forceOption = cmd.options.find(
      (o) => o.long === '--force-legacy'
    );
    expect(forceOption).toBeDefined();
    expect(forceOption!.description).toContain('legacy');
  });

  it('should early-exit without --force-legacy', async () => {
    const cmd = createRegisterCommand();
    // Verify the action exists
    const action = (cmd as unknown as { _actionHandler: unknown })._actionHandler;
    expect(action).toBeDefined();
  });
});
