import { ethers } from 'ethers';
import { DualNonceManager } from './DualNonceManager';
import { ENTRYPOINT_V06 } from './constants';

const sender = '0x' + '11'.repeat(20);
const kernel = '0x' + '22'.repeat(20);
const other = '0x' + '33'.repeat(20);
const indexedFields = 'bytes32 indexed txId,address indexed requester,address indexed provider';
const fields = 'uint256 amount,bytes32 serviceHash,uint256 timestamp,uint256 deadline,uint256 disputeWindow';

function creation(trailingAgreement: boolean, requester: string, index: number) {
  const iface = new ethers.Interface([`event TransactionCreated(${indexedFields},${fields}${trailingAgreement ? ',bytes32 agreementHash' : ''})`]);
  const args = [ethers.ZeroHash, requester, other, 1, ethers.ZeroHash, 1, 2, 1];
  const event = iface.encodeEventLog('TransactionCreated', trailingAgreement ? [...args, ethers.ZeroHash] : args);
  return {
    ...event, address: kernel, blockNumber: '0x1', blockHash: '0x' + 'ab'.repeat(32),
    transactionHash: '0x' + 'cd'.repeat(32), transactionIndex: '0x0', logIndex: ethers.toQuantity(index), removed: false,
  };
}

class HistoryProvider extends ethers.JsonRpcProvider {
  scans = 0;
  constructor(private readonly history: ReturnType<typeof creation>[], private readonly nonceError?: Error) {
    super('http://127.0.0.1:1', 31337, { staticNetwork: true });
  }
  override async send(method: string, params: unknown[]): Promise<unknown> {
    if (method === 'eth_call') {
      const call = params[0];
      if (typeof call !== 'object' || call === null || !('to' in call)) throw new Error('invalid call');
      if (call.to === ENTRYPOINT_V06.toLowerCase()) return ethers.toBeHex(0, 32);
      if (this.nonceError) throw this.nonceError;
      return '0x';
    }
    if (method === 'eth_blockNumber') return '0xa';
    if (method === 'eth_getCode') return params[1] === '0x0' ? '0x' : '0x6080';
    if (method === 'eth_getLogs') {
      this.scans++;
      const filter = params[0];
      if (typeof filter !== 'object' || filter === null || !('topics' in filter) || !Array.isArray(filter.topics)) throw new Error('missing topic filter');
      const [topics, , requester] = filter.topics;
      return this.history.filter(log => (Array.isArray(topics) ? topics.includes(log.topics[0]) : topics === log.topics[0]) && requester === log.topics[2]);
    }
    throw new Error('Unexpected RPC: ' + method);
  }
}

async function nonce(provider: HistoryProvider): Promise<bigint> {
  try {
    return await new DualNonceManager(provider, sender, kernel, 1).enqueue(async nonces => ({ result: nonces.actpNonce, success: false }));
  } finally { provider.destroy(); }
}

describe('DualNonceManager historical event compatibility', () => {
  it('counts encoded 8-field and 9-field history and excludes another requester', async () => {
    expect(await nonce(new HistoryProvider([creation(false, sender, 0), creation(true, sender, 1), creation(false, other, 2)]))).toBe(2n);
  });
  it('proves zero for a fresh requester', async () => {
    expect(await nonce(new HistoryProvider([creation(false, other, 0)]))).toBe(0n);
  });
  it.each(['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR'])('fails closed on %s without scanning history', async code => {
    const provider = new HistoryProvider([], Object.assign(new Error('RPC outage'), { code }));
    await expect(nonce(provider)).rejects.toThrow(/Refusing to infer/);
    expect(provider.scans).toBe(0);
  });
});
