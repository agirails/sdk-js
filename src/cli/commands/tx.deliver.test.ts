import { createTxCommand } from './tx';
import { createClient } from '../utils/client';
import { encodeDeliveryProof } from '../../utils/deliveryProof';

jest.mock('../utils/client', () => {
  const actual = jest.requireActual('../utils/client');
  return {
    ...actual,
    createClient: jest.fn(),
  };
});

const TX_ID = '0x' + 'a'.repeat(64);
// A real, explicit bytes32 result commitment (computeResultHash / AIP-16 envelope hash).
const RESULT_HASH = '0x' + '11'.repeat(32);

// AIP-14c: the DELIVERED transition carries the 64-byte (window, resultHash)
// proof. The resultHash MUST commit to a REAL deliverable — the CLI takes it via
// --result-hash (or --result, hashed). There is NO synthetic fallback.
const EXPECTED_PROOF = encodeDeliveryProof(172800, RESULT_HASH);

async function runDeliver(txId: string, extraArgs: string[] = []): Promise<void> {
  const txCmd = createTxCommand();
  await txCmd.parseAsync(['node', 'tx', 'deliver', txId, '--json', ...extraArgs]);
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

    await runDeliver(TX_ID, ['--result-hash', RESULT_HASH]);

    expect(transitionState).toHaveBeenNthCalledWith(1, TX_ID, 'IN_PROGRESS');
    expect(transitionState).toHaveBeenNthCalledWith(2, TX_ID, 'DELIVERED', EXPECTED_PROOF);
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

    await runDeliver(TX_ID, ['--result-hash', RESULT_HASH]);

    expect(transitionState).toHaveBeenCalledTimes(1);
    expect(transitionState).toHaveBeenCalledWith(TX_ID, 'DELIVERED', EXPECTED_PROOF);
  });

  it('derives the resultHash from a --result payload', async () => {
    const transitionState = jest.fn().mockResolvedValue(undefined);
    const getTransaction = jest
      .fn()
      .mockResolvedValueOnce({ id: TX_ID, state: 'IN_PROGRESS', disputeWindow: 172800 })
      .mockResolvedValueOnce({
        id: TX_ID,
        state: 'DELIVERED',
        completedAt: Math.floor(Date.now() / 1000),
        disputeWindow: 172800,
      });

    (createClient as unknown as jest.Mock).mockResolvedValue({
      standard: { getTransaction, transitionState },
    });

    // computeResultHash of this payload — encoded via the same helper the CLI uses.
    const { computeResultHash } = jest.requireActual('../../utils/canonicalJson');
    const payload = { ok: true, value: 42 };
    const expected = encodeDeliveryProof(172800, computeResultHash(payload));

    await runDeliver(TX_ID, ['--result', JSON.stringify(payload)]);

    expect(transitionState).toHaveBeenCalledWith(TX_ID, 'DELIVERED', expected);
  });

  it('FAILS CLOSED when neither --result-hash nor --result is given (no synthetic hash)', async () => {
    const transitionState = jest.fn().mockResolvedValue(undefined);
    const getTransaction = jest
      .fn()
      .mockResolvedValue({ id: TX_ID, state: 'IN_PROGRESS', disputeWindow: 172800 });

    (createClient as unknown as jest.Mock).mockResolvedValue({
      standard: { getTransaction, transitionState },
    });

    // The command catches the fail-closed error and calls process.exit(1).
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    await expect(runDeliver(TX_ID)).rejects.toThrow('process.exit');
    // Crucially: it NEVER sent the DELIVERED transition.
    expect(transitionState).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});
