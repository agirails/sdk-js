/**
 * Deploy:env Command Tests (AIP-13)
 *
 * @module cli/commands/deploy-env.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Wallet } from 'ethers';
import { Output } from '../utils/output';
import { runDeployEnv } from './deploy-env';

const TEST_PASSWORD = 'test-password-123';

describe('deploy:env command', () => {
  let testDir: string;
  let originalCwd: () => string;
  let printedLines: string[];
  let resultData: Record<string, unknown> | null;
  let output: Output;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-env-test-'));

    // Create a keystore
    const actpDir = path.join(testDir, '.actp');
    fs.mkdirSync(actpDir, { recursive: true });
    const wallet = Wallet.createRandom();
    const encrypted = await wallet.encrypt(TEST_PASSWORD);
    fs.writeFileSync(path.join(actpDir, 'keystore.json'), encrypted, { mode: 0o600 });

    // Mock cwd
    originalCwd = process.cwd;
    process.cwd = () => testDir;

    // Capture output
    printedLines = [];
    resultData = null;
    output = new Output('human');
    jest.spyOn(output, 'print').mockImplementation((msg: string) => { printedLines.push(msg); });
    jest.spyOn(output, 'result').mockImplementation((data: Record<string, unknown>) => { resultData = data; });
  });

  afterEach(() => {
    process.cwd = originalCwd;
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    jest.restoreAllMocks();
  });

  test('outputs base64-encoded keystore in shell format', () => {
    runDeployEnv({ format: 'shell' }, output);

    const joined = printedLines.join('\n');
    expect(joined).toContain('ACTP_KEYSTORE_BASE64=');
    expect(joined).toContain('ACTP_KEY_PASSWORD=');
    expect(joined).toContain('SEPARATE secret scopes');
  });

  test('outputs docker format', () => {
    runDeployEnv({ format: 'docker' }, output);

    const joined = printedLines.join('\n');
    expect(joined).toContain('ENV ACTP_KEYSTORE_BASE64=');
    expect(joined).toContain('ENV ACTP_KEY_PASSWORD=');
  });

  test('outputs JSON format', () => {
    runDeployEnv({ format: 'json', json: true }, output);

    expect(resultData).toBeTruthy();
    expect(resultData!.keystoreBase64).toBeTruthy();
    expect(resultData!.passwordVar).toBe('ACTP_KEY_PASSWORD');
  });

  test('quiet mode outputs only the base64 string', () => {
    runDeployEnv({ format: 'shell', quiet: true }, output);

    expect(resultData).toBeTruthy();
    expect(typeof resultData!.keystoreBase64).toBe('string');
    expect((resultData!.keystoreBase64 as string).length).toBeGreaterThan(10);
  });

  test('base64 output decodes to valid JSON', () => {
    runDeployEnv({ format: 'shell' }, output);

    // Extract base64 from output
    const b64Line = printedLines.find(l => l.startsWith('ACTP_KEYSTORE_BASE64='));
    expect(b64Line).toBeTruthy();
    const b64 = b64Line!.split('=')[1];
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    expect(() => JSON.parse(decoded)).not.toThrow();
  });

  test('fails gracefully when no keystore exists', () => {
    // Remove keystore
    fs.rmSync(path.join(testDir, '.actp', 'keystore.json'));

    expect(() => runDeployEnv({ format: 'shell' }, output)).toThrow('No keystore found');
  });
});
