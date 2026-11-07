import { createTxCommand } from './tx';
import { OperationNotSupportedError } from '../../errors';

const mockGetAllTransactions = jest.fn();

jest.mock('../utils/client', () => ({
  ...jest.requireActual<typeof import('../utils/client')>('../utils/client'),
  createClient: jest.fn(() => Promise.resolve({ advanced: { getAllTransactions: mockGetAllTransactions } })),
}));

class ExitCalled extends Error {}

async function runList(extraArgs: string[] = []): Promise<void> {
  const txCmd = createTxCommand();
  await txCmd.parseAsync(['node', 'tx', 'list', ...extraArgs]);
}

describe('tx list command', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;
  let exit: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    exit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
      throw new ExitCalled(`exit ${String(code)}`);
    });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
    exit.mockRestore();
  });

  it('on a real chain prints the per-address hint and an empty list, not an error', async () => {
    mockGetAllTransactions.mockRejectedValue(
      new OperationNotSupportedError('getAllTransactions()', 'BlockchainRuntime', 'Use getTransaction(txId).')
    );

    await runList();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not yet supported on testnet/mainnet'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Transactions (0)'));
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not hide other runtime failures behind the hint', async () => {
    mockGetAllTransactions.mockRejectedValue(new Error('rpc down'));

    await expect(runList()).rejects.toThrow('exit 1');

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('not yet supported on testnet/mainnet'));
  });
});
