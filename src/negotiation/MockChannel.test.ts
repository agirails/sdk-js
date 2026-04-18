/**
 * MockChannel — covers the contract every NegotiationChannel impl
 * must satisfy. RelayChannel mirrors these tests against an HTTP fake.
 */

import { Wallet, HDNodeWallet } from 'ethers';
import { MockChannel } from './MockChannel';
import { QuoteBuilder, QuoteMessage } from '../builders/QuoteBuilder';
import { CounterOfferBuilder, CounterOfferMessage } from '../builders/CounterOfferBuilder';
import { CounterAcceptBuilder, CounterAcceptMessage } from '../builders/CounterAcceptBuilder';
import { InMemoryNonceManager } from '../utils/NonceManager';
import type { NegotiationMessage, DeliveredMessage } from './NegotiationChannel';

const KERNEL = '0x1234567890123456789012345678901234567890';
const CHAIN_ID = 84_532;
const TX_ID = '0x' + 'a'.repeat(64);

async function buildQuote(provider: HDNodeWallet, consumer: HDNodeWallet): Promise<NegotiationMessage> {
  const builder = new QuoteBuilder(provider, new InMemoryNonceManager());
  const quote = await builder.build({
    txId: TX_ID,
    provider: `did:ethr:${CHAIN_ID}:${provider.address}`,
    consumer: `did:ethr:${CHAIN_ID}:${consumer.address}`,
    quotedAmount: '7000000',
    originalAmount: '5000000',
    maxPrice: '10000000',
    chainId: CHAIN_ID,
    kernelAddress: KERNEL,
  });
  return { type: 'agirails.quote.v1', message: quote };
}

async function buildCounter(provider: HDNodeWallet, consumer: HDNodeWallet, quote: QuoteMessage): Promise<NegotiationMessage> {
  const builder = new CounterOfferBuilder(consumer, new InMemoryNonceManager());
  const counter = await builder.build({
    txId: TX_ID,
    consumer: `did:ethr:${CHAIN_ID}:${consumer.address}`,
    provider: `did:ethr:${CHAIN_ID}:${provider.address}`,
    quoteAmount: quote.quotedAmount,
    counterAmount: '6000000',
    maxPrice: quote.maxPrice,
    inReplyTo: new QuoteBuilder().computeHash(quote),
    chainId: CHAIN_ID,
    kernelAddress: KERNEL,
  });
  return { type: 'agirails.counteroffer.v1', message: counter };
}

async function buildAccept(provider: HDNodeWallet, consumer: HDNodeWallet, counter: CounterOfferMessage): Promise<NegotiationMessage> {
  const builder = new CounterAcceptBuilder(provider, new InMemoryNonceManager());
  const counterHash = new CounterOfferBuilder().computeHash(counter);
  const accept = await builder.build({
    txId: TX_ID,
    provider: `did:ethr:${CHAIN_ID}:${provider.address}`,
    consumer: `did:ethr:${CHAIN_ID}:${consumer.address}`,
    acceptedAmount: counter.counterAmount,
    inReplyTo: counterHash,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL,
  });
  return { type: 'agirails.counteraccept.v1', message: accept };
}

describe('MockChannel', () => {
  let provider: HDNodeWallet;
  let consumer: HDNodeWallet;
  let channel: MockChannel;

  beforeEach(() => {
    provider = Wallet.createRandom();
    consumer = Wallet.createRandom();
    channel = new MockChannel({ kernelAddressByChainId: { [CHAIN_ID]: KERNEL } });
  });

  // ==========================================================================
  // post + subscribeTxId
  // ==========================================================================

  it('delivers a posted quote to a txId subscriber', async () => {
    const received: DeliveredMessage[] = [];
    channel.subscribeTxId(TX_ID, (d) => { received.push(d); });
    const quote = await buildQuote(provider, consumer);
    await channel.post(TX_ID, quote);
    // Wait for microtask fan-out + verify pass.
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(received[0].envelope.type).toBe('agirails.quote.v1');
  });

  it('replays existing messages to a late subscriber', async () => {
    const quote = await buildQuote(provider, consumer);
    await channel.post(TX_ID, quote);
    await new Promise((r) => setTimeout(r, 10));

    const received: DeliveredMessage[] = [];
    channel.subscribeTxId(TX_ID, (d) => { received.push(d); });
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].envelope.message.signature).toBe(quote.message.signature);
  });

  it('does NOT cross-deliver messages between txIds', async () => {
    const otherTxId = '0x' + 'b'.repeat(64);
    const received: DeliveredMessage[] = [];
    channel.subscribeTxId(otherTxId, (d) => { received.push(d); });
    const quote = await buildQuote(provider, consumer);
    await channel.post(TX_ID, quote);
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });

  it('dedups: same message delivered only once even if posted twice', async () => {
    const received: DeliveredMessage[] = [];
    channel.subscribeTxId(TX_ID, (d) => { received.push(d); });
    const quote = await buildQuote(provider, consumer);
    await channel.post(TX_ID, quote);
    await channel.post(TX_ID, quote); // duplicate
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
  });

  it('drops messages that fail signature verify', async () => {
    const received: DeliveredMessage[] = [];
    channel.subscribeTxId(TX_ID, (d) => { received.push(d); });
    const quote = await buildQuote(provider, consumer);
    // Tamper with the signature.
    const tampered: NegotiationMessage = {
      type: 'agirails.quote.v1',
      message: { ...quote.message as QuoteMessage, signature: '0x' + '0'.repeat(130) },
    };
    await channel.post(TX_ID, tampered);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(0);
  });

  it('drops messages for unknown chainId (kernel address not configured)', async () => {
    const otherChannel = new MockChannel({ kernelAddressByChainId: {} }); // no chains configured
    const received: DeliveredMessage[] = [];
    otherChannel.subscribeTxId(TX_ID, (d) => { received.push(d); });
    const quote = await buildQuote(provider, consumer);
    await otherChannel.post(TX_ID, quote);
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });

  // ==========================================================================
  // subscribeAgent
  // ==========================================================================

  it('delivers messages addressed to an agent DID across multiple txIds', async () => {
    const otherTxId = '0x' + 'c'.repeat(64);
    const providerDID = `did:ethr:${CHAIN_ID}:${provider.address}`;
    const collected: Array<{ txId: string; type: string }> = [];
    channel.subscribeAgent(providerDID, (txId, d) => { collected.push({ txId, type: d.envelope.type }); });
    // Use a shared nonce manager so the two quote signatures differ
    // (otherwise identical content → identical sig → MockChannel dedups).
    const sharedNm = new InMemoryNonceManager();
    const builder = new QuoteBuilder(provider, sharedNm);
    const quote1 = await builder.build({
      txId: TX_ID, provider: providerDID,
      consumer: `did:ethr:${CHAIN_ID}:${consumer.address}`,
      quotedAmount: '7000000', originalAmount: '5000000', maxPrice: '10000000',
      chainId: CHAIN_ID, kernelAddress: KERNEL,
    });
    const quote2 = await builder.build({
      txId: otherTxId, provider: providerDID,
      consumer: `did:ethr:${CHAIN_ID}:${consumer.address}`,
      quotedAmount: '7500000', originalAmount: '5000000', maxPrice: '10000000',
      chainId: CHAIN_ID, kernelAddress: KERNEL,
    });
    await channel.post(TX_ID, { type: 'agirails.quote.v1', message: quote1 });
    await channel.post(otherTxId, { type: 'agirails.quote.v1', message: quote2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(collected).toHaveLength(2);
    expect(collected.map((c) => c.txId).sort()).toEqual([TX_ID, otherTxId].sort());
  });

  it('does NOT deliver agent messages addressed to a different DID', async () => {
    const otherWallet = Wallet.createRandom();
    const otherDID = `did:ethr:${CHAIN_ID}:${otherWallet.address}`;
    const received: Array<unknown> = [];
    channel.subscribeAgent(otherDID, () => { received.push(1); });
    const quote = await buildQuote(provider, consumer); // provider+consumer ≠ otherWallet
    await channel.post(TX_ID, quote);
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });

  // ==========================================================================
  // unsubscribe
  // ==========================================================================

  it('stops delivering after unsubscribe', async () => {
    const received: DeliveredMessage[] = [];
    const sub = channel.subscribeTxId(TX_ID, (d) => { received.push(d); });
    sub.unsubscribe();
    const quote = await buildQuote(provider, consumer);
    await channel.post(TX_ID, quote);
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
    expect(channel.activeSubscriptionCount()).toBe(0);
  });

  it('unsubscribe is idempotent', () => {
    const sub = channel.subscribeTxId(TX_ID, () => undefined);
    sub.unsubscribe();
    expect(() => sub.unsubscribe()).not.toThrow();
  });

  // ==========================================================================
  // round trip — quote → counter → counteraccept
  // ==========================================================================

  it('routes a full quote → counter → counteraccept exchange', async () => {
    // Provider subscribes to inbox (counters arrive here)
    const providerDID = `did:ethr:${CHAIN_ID}:${provider.address}`;
    const providerInbox: NegotiationMessage[] = [];
    channel.subscribeAgent(providerDID, (_txId, d) => { providerInbox.push(d.envelope); });

    // Buyer subscribes to txId (quotes + accepts arrive here)
    const buyerInbox: NegotiationMessage[] = [];
    channel.subscribeTxId(TX_ID, (d) => { buyerInbox.push(d.envelope); });

    // 1. Provider posts quote → buyer + provider both receive
    const quote = await buildQuote(provider, consumer);
    await channel.post(TX_ID, quote);
    await new Promise((r) => setTimeout(r, 10));

    // 2. Buyer posts counter → provider receives via subscribeAgent
    const counter = await buildCounter(provider, consumer, quote.message as QuoteMessage);
    await channel.post(TX_ID, counter);
    await new Promise((r) => setTimeout(r, 10));

    // 3. Provider posts accept → buyer receives via subscribeTxId
    const accept = await buildAccept(provider, consumer, counter.message as CounterOfferMessage);
    await channel.post(TX_ID, accept);
    await new Promise((r) => setTimeout(r, 10));

    // Provider's inbox: quote (self) + counter
    expect(providerInbox.map((e) => e.type)).toEqual(
      expect.arrayContaining(['agirails.quote.v1', 'agirails.counteroffer.v1']),
    );
    // Buyer's inbox: quote + accept (counter is buyer's own outbound, also delivered to txId sub)
    const buyerTypes = buyerInbox.map((e) => e.type);
    expect(buyerTypes).toContain('agirails.quote.v1');
    expect(buyerTypes).toContain('agirails.counteraccept.v1');

    // Verify the accept message body matches what we expected
    const acceptEnvelope = buyerInbox.find((e) => e.type === 'agirails.counteraccept.v1');
    expect(acceptEnvelope).toBeDefined();
    const acceptMsg = acceptEnvelope!.message as CounterAcceptMessage;
    expect(acceptMsg.acceptedAmount).toBe('6000000');
  });
});
