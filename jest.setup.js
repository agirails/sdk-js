/**
 * Jest Setup File
 *
 * Preserves and restores the current working directory
 * to prevent uv_cwd errors when tests create/delete temp directories.
 */

const originalCwd = process.cwd();

const realFetch = globalThis.fetch;
let productionPublishAttempts = [];

function isProductionPublishProxy(raw) {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return url.hostname === 'api.agirails.io' && /\/v1\/publish\/?$/.test(url.pathname);
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  if (isProductionPublishProxy(url)) {
    productionPublishAttempts.push(expect.getState().currentTestName ?? '(outside a test)');
    throw new Error(
      `Test tried to publish to the production proxy (${url}). ` +
        'Mock fetch for the /v1/publish path in the test.',
    );
  }
  return realFetch(input, init);
};

function failTestsThatReachedProductionPublish() {
  if (productionPublishAttempts.length > 0) {
    const names = productionPublishAttempts;
    productionPublishAttempts = [];
    throw new Error(`Production publish proxy called from test: ${names.join(', ')}`);
  }
}
afterEach(failTestsThatReachedProductionPublish);
afterAll(failTestsThatReachedProductionPublish);

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
