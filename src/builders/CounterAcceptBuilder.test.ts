import { CounterAcceptBuilder, CounterAcceptParams, CounterAcceptMessage } from './CounterAcceptBuilder';
import { Wallet, HDNodeWallet } from 'ethers';
import { InMemoryNonceManager } from '../utils/NonceManager';

describe('CounterAcceptBuilder', () => {
  let builder: CounterAcceptBuilder;
  let providerWallet: HDNodeWallet;
  let nm: InMemoryNonceManager;
  const KERNEL = '0x1234567890123456789012345678901234567890';
  const TX_ID = '0x' + 'a'.repeat(64);
  const COUNTER_HASH = '0x' + 'b'.repeat(64);
  const CONSUMER_DID = 'did:ethr:84532:0x2222222222222222222222222222222222222222';
  let providerDID: string;

  beforeEach(() => {
    providerWallet = Wallet.createRandom();
    providerDID = `did:ethr:84532:${providerWallet.address}`;
    nm = new InMemoryNonceManager();
    builder = new CounterAcceptBuilder(providerWallet, nm);
  });

  function baseParams(over: Partial<CounterAcceptParams> = {}): CounterAcceptParams {
    return {
      txId: TX_ID,
      provider: providerDID,
      consumer: CONSUMER_DID,
      acceptedAmount: '6000000', // $6, equals counter.counterAmount
      inReplyTo: COUNTER_HASH,
      chainId: 84532,
      kernelAddress: KERNEL,
      ...over,
    };
  }

  describe('build()', () => {
    it('produces a fully populated signed message', async () => {
      const before = Math.floor(Date.now() / 1000);
      const m = await builder.build(baseParams());
      const after = Math.floor(Date.now() / 1000);

      expect(m.type).toBe('agirails.counteraccept.v1');
      expect(m.txId).toBe(TX_ID);
      expect(m.provider).toBe(providerDID);
      expect(m.consumer).toBe(CONSUMER_DID);
      expect(m.acceptedAmount).toBe('6000000');
      expect(m.inReplyTo).toBe(COUNTER_HASH);
      expect(m.acceptedAt).toBeGreaterThanOrEqual(before);
      expect(m.acceptedAt).toBeLessThanOrEqual(after);
      expect(m.nonce).toBe(1);
      expect(m.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
    });

    it('rejects acceptedAmount below platform minimum', async () => {
      await expect(builder.build(baseParams({ acceptedAmount: '40000' }))).rejects.toThrow(/platform minimum/);
    });

    it('rejects malformed inReplyTo (must be 32-byte hash)', async () => {
      await expect(builder.build(baseParams({ inReplyTo: '0xabc' }))).rejects.toThrow(/inReplyTo/);
    });

    it('rejects unsupported chainId', async () => {
      await expect(builder.build(baseParams({ chainId: 1 }))).rejects.toThrow(/chainId/);
    });

    it('increments nonce monotonically', async () => {
      const a = await builder.build(baseParams());
      const b = await builder.build(baseParams({ acceptedAmount: '6500000' }));
      expect(a.nonce).toBe(1);
      expect(b.nonce).toBe(2);
    });
  });

  describe('verify()', () => {
    it('round-trips a fresh build', async () => {
      const m = await builder.build(baseParams());
      await expect(builder.verify(m, KERNEL)).resolves.toBe(true);
    });

    it('rejects when provider DID does not match recovered signer', async () => {
      const m = await builder.build(baseParams());
      const bogus: CounterAcceptMessage = {
        ...m,
        provider: 'did:ethr:84532:0x9999999999999999999999999999999999999999',
      };
      await expect(builder.verify(bogus, KERNEL)).rejects.toThrow();
    });

    it('rejects message signed for a different kernel', async () => {
      const m = await builder.build(baseParams());
      await expect(
        builder.verify(m, '0x9999999999999999999999999999999999999999'),
      ).rejects.toThrow();
    });
  });

  describe('computeHash()', () => {
    it('is deterministic and signature-independent', async () => {
      const m = await builder.build(baseParams());
      const h1 = builder.computeHash(m);
      const h2 = builder.computeHash({ ...m, signature: '0x' + '00'.repeat(65) });
      expect(h1).toBe(h2);
    });
  });
});
