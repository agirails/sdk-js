import { createTxCommand } from './tx';
import { createClient } from '../utils/client';

jest.mock('../utils/client', () => {
  const actual = jest.requireActual('../utils/client');
  return {
    ...actual,
    createClient: jest.fn(),
  };
});

const TX_ID = '0x' + 'a'.repeat(64);

async function runDeliver(txId: string): Promise<void> {
  const txCmd = createTxCommand();
  await txCmd.parseAsync(['node', 'tx', 'deliver', txId, '--json']);
}

describe('tx deliver command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('auto-transitions COMMITTED -> IN_PROGRESS -> DELIVERED', async () => {
    const transitionState = jest.fn().mockResolvedValue(undefined);
    const getTransaction = jest
      .fn()
      .mockResolvedValueOnce({
        id: TX_ID,
        state: 'COMMITTED',
        disputeWindow: 172800,
      })
      .mockResolvedValueOnce({
        id: TX_ID,
        state: 'DELIVERED',
        completedAt: Math.floor(Date.now() / 1000),
        disputeWindow: 172800,
      });

    (createClient as unknown as jest.Mock).mockResolvedValue({
      standard: { getTransaction, transitionState },
    });

    await runDeliver(TX_ID);

    expect(transitionState).toHaveBeenNthCalledWith(1, TX_ID, 'IN_PROGRESS');
    expect(transitionState).toHaveBeenNthCalledWith(2, TX_ID, 'DELIVERED');
  });

  it('transitions IN_PROGRESS -> DELIVERED', async () => {
    const transitionState = jest.fn().mockResolvedValue(undefined);
    const getTransaction = jest
      .fn()
      .mockResolvedValueOnce({
        id: TX_ID,
        state: 'IN_PROGRESS',
        disputeWindow: 172800,
      })
      .mockResolvedValueOnce({
        id: TX_ID,
        state: 'DELIVERED',
        completedAt: Math.floor(Date.now() / 1000),
        disputeWindow: 172800,
      });

    (createClient as unknown as jest.Mock).mockResolvedValue({
      standard: { getTransaction, transitionState },
    });

    await runDeliver(TX_ID);

    expect(transitionState).toHaveBeenCalledTimes(1);
    expect(transitionState).toHaveBeenCalledWith(TX_ID, 'DELIVERED');
  });
});
