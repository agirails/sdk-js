/**
 * Jest Setup File
 *
 * Preserves and restores the current working directory
 * to prevent uv_cwd errors when tests create/delete temp directories.
 */

const originalCwd = process.cwd();

// Restore cwd after each test file
afterAll(() => {
  try {
    process.chdir(originalCwd);
  } catch {
    // Directory might not exist, ignore
  }
});

// Extra safety: also restore before each test suite
beforeAll(() => {
  try {
    process.chdir(originalCwd);
  } catch {
    // Directory might not exist, ignore
  }
});
