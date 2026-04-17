/**
 * Test Job Selector + Receipt Renderer Tests
 *
 * @module cli/testjobs/testjobs.test
 */

import { selectTestJob, TestJob } from './index';
import { renderReceipt, ReceiptData } from '../commands/receipt';
import { Output } from '../utils/output';

// ============================================================================
// selectTestJob
// ============================================================================

describe('selectTestJob', () => {
  test('matches code-review service', () => {
    const job = selectTestJob(['code-review']);
    expect(job.serviceType).toBe('code-review');
    expect(job.title).toBeTruthy();
    expect(job.input).toBeDefined();
    expect(job.expectedDeliverable).toBeTruthy();
  });

  test('matches translation service', () => {
    const job = selectTestJob(['translation']);
    expect(job.serviceType).toBe('translation');
  });

  test('matches security-audit service', () => {
    const job = selectTestJob(['security-audit']);
    expect(job.serviceType).toBe('security-audit');
  });

  test('matches data-analysis service', () => {
    const job = selectTestJob(['data-analysis']);
    expect(job.serviceType).toBe('data-analysis');
  });

  test('matches content-writing service', () => {
    const job = selectTestJob(['content-writing']);
    expect(job.serviceType).toBe('content-writing');
  });

  test('matches testing service', () => {
    const job = selectTestJob(['testing']);
    expect(job.serviceType).toBe('testing');
  });

  test('matches automation service', () => {
    const job = selectTestJob(['automation']);
    expect(job.serviceType).toBe('automation');
  });

  test('returns generic for unknown service', () => {
    const job = selectTestJob(['something-custom']);
    expect(job.serviceType).toBe('generic');
  });

  test('returns generic for empty services array', () => {
    const job = selectTestJob([]);
    expect(job.serviceType).toBe('generic');
  });

  test('matches first known service in array', () => {
    const job = selectTestJob(['unknown', 'translation', 'code-review']);
    expect(job.serviceType).toBe('translation');
  });

  test('normalizes case and whitespace', () => {
    const job = selectTestJob(['  Code-Review  ']);
    expect(job.serviceType).toBe('code-review');
  });

  test('all templates have required fields', () => {
    const services = [
      'code-review', 'translation', 'security-audit',
      'data-analysis', 'content-writing', 'testing', 'automation',
    ];
    for (const svc of services) {
      const job = selectTestJob([svc]);
      expect(job.serviceType).toBe(svc);
      expect(typeof job.title).toBe('string');
      expect(typeof job.input).toBe('object');
      expect(typeof job.expectedDeliverable).toBe('string');
    }
  });
});

// ============================================================================
// renderReceipt
// ============================================================================

describe('renderReceipt', () => {
  const receiptData: ReceiptData = {
    agent: 'code-reviewer',
    service: 'code-review',
    amountWei: 5_000_000n, // $5 USDC
    network: 'mock',
    txId: '0x1234567890abcdef1234567890abcdef12345678',
  };

  test('JSON mode outputs structured data', () => {
    const output = new Output('json');
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg); });

    renderReceipt(receiptData, output);

    const json = JSON.parse(lines[0]);
    expect(json.agent).toBe('code-reviewer');
    expect(json.service).toBe('code-review');
    expect(json.earned).toContain('$5.00');
    expect(json.net).toBeDefined();
    expect(json.fee).toBeDefined();
    expect(json.feePercent).toBeDefined();
    expect(json.network).toBe('mock');
    expect(json.txId).toBe(receiptData.txId);

    jest.restoreAllMocks();
  });

  test('quiet mode calls print with net amount (suppressed by Output)', () => {
    // In quiet mode, Output.print() is a no-op (only outputs in human mode).
    // renderReceipt calls output.print() for quiet — verify it's called correctly
    // by spying on the Output instance method directly.
    const output = new Output('quiet');
    const printCalls: string[] = [];
    jest.spyOn(output, 'print').mockImplementation((msg: string) => { printCalls.push(msg); });

    renderReceipt(receiptData, output);

    expect(printCalls).toHaveLength(1);
    expect(printCalls[0]).toContain('USDC');
    expect(printCalls[0]).toContain('$');

    jest.restoreAllMocks();
  });

  test('human mode outputs box-drawing receipt', () => {
    const output = new Output('human');
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg); });

    renderReceipt(receiptData, output);

    const joined = lines.join('\n');
    expect(joined).toContain('FIRST TRANSACTION RECEIPT');
    expect(joined).toContain('code-reviewer');
    expect(joined).toContain('code-review');
    expect(joined).toContain('mock');
    expect(joined).toContain('SETTLED');
    expect(joined).toContain('Autonomously. Trustlessly');

    jest.restoreAllMocks();
  });

  test('JSON mode calculates correct fee for $5 USDC', () => {
    const output = new Output('json');
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg); });

    renderReceipt(receiptData, output);

    const json = JSON.parse(lines[0]);
    // $5 USDC → 1% = $0.05 (exactly at minimum)
    expect(json.fee).toBe('$0.05 USDC');
    expect(json.net).toBe('$4.95 USDC');
    expect(json.feePercent).toBe('1%');

    jest.restoreAllMocks();
  });

  test('JSON mode handles $1 USDC (minimum fee kicks in)', () => {
    const output = new Output('json');
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg); });

    renderReceipt({ ...receiptData, amountWei: 1_000_000n }, output);

    const json = JSON.parse(lines[0]);
    // $1 USDC → 1% = $0.01, but minimum is $0.05
    expect(json.fee).toBe('$0.05 USDC');
    expect(json.net).toBe('$0.95 USDC');
    expect(json.feePercent).toBe('5%');

    jest.restoreAllMocks();
  });

  test('human mode surfaces net amount in ceremonial receipt', () => {
    const output = new Output('human');
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg); });

    renderReceipt(receiptData, output);

    // Strip ANSI escape codes before asserting — the ceremonial receipt
    // uses colors that otherwise break literal substring matches.
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const joined = stripAnsi(lines.join('\n'));
    // Human receipt is ceremonial (not a fee breakdown table) — it shows
    // net earnings + provenance. Fee breakdown lives in JSON mode.
    expect(joined).toContain('earned $4.95 USDC');
    expect(joined).toContain('SETTLED');

    jest.restoreAllMocks();
  });

  test('JSON mode handles zero amount (feePercent 0% branch)', () => {
    const output = new Output('json');
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg); });

    renderReceipt({ ...receiptData, amountWei: 0n }, output);

    const json = JSON.parse(lines[0]);
    expect(json.feePercent).toBe('0%');

    jest.restoreAllMocks();
  });

  test('testnet variant includes Eth Tx and Verify lines', () => {
    const output = new Output('human');
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg); });

    renderReceipt({
      ...receiptData,
      network: 'base-sepolia',
      ethTxHash: '0xabcdef1234567890abcdef1234567890abcdef12',
    }, output);

    const joined = lines.join('\n');
    expect(joined).toContain('Eth Tx');
    expect(joined).toContain('Verify');
    expect(joined).toContain('sepolia.basescan.org');

    jest.restoreAllMocks();
  });

  test('mainnet variant uses "FIRST MAINNET SETTLEMENT" header', () => {
    const output = new Output('human');
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg); });

    renderReceipt({
      ...receiptData,
      network: 'base-mainnet',
      ethTxHash: '0xabcdef1234567890abcdef1234567890abcdef12',
    }, output);

    const joined = lines.join('\n');
    expect(joined).toContain('FIRST MAINNET SETTLEMENT');
    expect(joined).toContain('This is real money');
    expect(joined).toContain('basescan.org');
    expect(joined).not.toContain('sepolia');

    jest.restoreAllMocks();
  });
});
