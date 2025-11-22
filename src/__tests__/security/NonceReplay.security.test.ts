/**
 * Nonce Replay Attack Prevention Test Suite
 *
 * V4 Security Vulnerability: EIP-712 Replay Attack via Nonce Reuse
 *
 * Coverage Target: 100% (security-critical code)
 *
 * Test Categories:
 * 1. ReceivedNonceTracker - Memory-Efficient Strategy (7 tests)
 * 2. ReceivedNonceTracker - Set-Based Strategy (6 tests)
 * 3. MessageSigner Integration - Replay Prevention (8 tests)
 *
 * Attack Vectors Tested:
 * - Duplicate nonce replay (same message sent twice)
 * - Old nonce replay (replay with lower nonce)
 * - Out-of-order nonce handling
 * - Cross-sender nonce isolation
 * - Cross-message-type nonce isolation
 *
 * References:
 * - ReceivedNonceTracker.ts implementation
 * - MessageSigner.ts nonce validation
 * - V4 vulnerability documentation
 */

import { Wallet } from 'ethers';
import { MessageSigner } from '../../protocol/MessageSigner';
import {
  InMemoryReceivedNonceTracker,
  SetBasedReceivedNonceTracker,
  createReceivedNonceTracker
} from '../../utils/ReceivedNonceTracker';
import { ACTPMessage } from '../../types';

// Test signers
const testPrivateKey1 = '0x' + '1'.repeat(64);
const testPrivateKey2 = '0x' + '2'.repeat(64);
const signer1 = new Wallet(testPrivateKey1);
const signer2 = new Wallet(testPrivateKey2);

const TEST_KERNEL_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('ReceivedNonceTracker - Memory-Efficient Strategy', () => {
  let tracker: InMemoryReceivedNonceTracker;

  beforeEach(() => {
    tracker = new InMemoryReceivedNonceTracker();
  });

  it('should accept first nonce from sender', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType = 'test.message';
    const nonce = '0x' + '0'.repeat(63) + '1';

    const result = tracker.validateAndRecord(sender, messageType, nonce);

    expect(result.valid).toBe(true);
    expect(tracker.getHighestNonce(sender, messageType)).toBe(nonce);
  });

  it('should accept monotonically increasing nonces', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType = 'test.message';

    // Nonce 1
    const nonce1 = '0x' + '0'.repeat(63) + '1';
    const result1 = tracker.validateAndRecord(sender, messageType, nonce1);
    expect(result1.valid).toBe(true);

    // Nonce 2
    const nonce2 = '0x' + '0'.repeat(63) + '2';
    const result2 = tracker.validateAndRecord(sender, messageType, nonce2);
    expect(result2.valid).toBe(true);

    // Nonce 10
    const nonce10 = '0x' + '0'.repeat(63) + 'a'; // hex 'a' = 10
    const result10 = tracker.validateAndRecord(sender, messageType, nonce10);
    expect(result10.valid).toBe(true);
  });

  it('should reject duplicate nonce (exact replay)', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType = 'test.message';
    const nonce = '0x' + '0'.repeat(63) + '5';

    // First use - accepted
    const result1 = tracker.validateAndRecord(sender, messageType, nonce);
    expect(result1.valid).toBe(true);

    // Duplicate - rejected
    const result2 = tracker.validateAndRecord(sender, messageType, nonce);
    expect(result2.valid).toBe(false);
    expect(result2.reason).toContain('Nonce replay detected');
    expect(result2.receivedNonce).toBe(nonce);
  });

  it('should reject old nonce (lower than highest seen)', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType = 'test.message';

    // Nonce 10
    const nonce10 = '0x' + '0'.repeat(63) + 'a';
    const result10 = tracker.validateAndRecord(sender, messageType, nonce10);
    expect(result10.valid).toBe(true);

    // Nonce 5 (old replay attempt)
    const nonce5 = '0x' + '0'.repeat(63) + '5';
    const result5 = tracker.validateAndRecord(sender, messageType, nonce5);
    expect(result5.valid).toBe(false);
    expect(result5.reason).toContain('Nonce replay detected');
  });

  it('should isolate nonces by sender', () => {
    const sender1 = `did:ethr:${signer1.address}`;
    const sender2 = `did:ethr:${signer2.address}`;
    const messageType = 'test.message';
    const nonce = '0x' + '0'.repeat(63) + '1';

    // Sender 1 uses nonce 1
    const result1 = tracker.validateAndRecord(sender1, messageType, nonce);
    expect(result1.valid).toBe(true);

    // Sender 2 can also use nonce 1 (different sender)
    const result2 = tracker.validateAndRecord(sender2, messageType, nonce);
    expect(result2.valid).toBe(true);
  });

  it('should isolate nonces by message type', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType1 = 'test.message.v1';
    const messageType2 = 'test.message.v2';
    const nonce = '0x' + '0'.repeat(63) + '1';

    // Message type 1 uses nonce 1
    const result1 = tracker.validateAndRecord(sender, messageType1, nonce);
    expect(result1.valid).toBe(true);

    // Message type 2 can also use nonce 1 (different type)
    const result2 = tracker.validateAndRecord(sender, messageType2, nonce);
    expect(result2.valid).toBe(true);
  });

  it('should reject invalid nonce format', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType = 'test.message';

    // Too short
    const result1 = tracker.validateAndRecord(sender, messageType, '0x123');
    expect(result1.valid).toBe(false);
    expect(result1.reason).toContain('Invalid nonce format');

    // Not hex
    const result2 = tracker.validateAndRecord(sender, messageType, 'invalid');
    expect(result2.valid).toBe(false);
    expect(result2.reason).toContain('Invalid nonce format');
  });
});

describe('ReceivedNonceTracker - Set-Based Strategy', () => {
  let tracker: SetBasedReceivedNonceTracker;

  beforeEach(() => {
    tracker = new SetBasedReceivedNonceTracker();
  });

  it('should accept first nonce from sender', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType = 'test.message';
    const nonce = '0x' + '0'.repeat(63) + '1';

    const result = tracker.validateAndRecord(sender, messageType, nonce);

    expect(result.valid).toBe(true);
    expect(tracker.hasBeenUsed(sender, messageType, nonce)).toBe(true);
  });

  it('should accept out-of-order nonces', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType = 'test.message';

    // Nonce 10 first
    const nonce10 = '0x' + '0'.repeat(63) + 'a';
    const result10 = tracker.validateAndRecord(sender, messageType, nonce10);
    expect(result10.valid).toBe(true);

    // Nonce 5 (lower, but still accepted in set-based strategy)
    const nonce5 = '0x' + '0'.repeat(63) + '5';
    const result5 = tracker.validateAndRecord(sender, messageType, nonce5);
    expect(result5.valid).toBe(true); // Set-based allows out-of-order

    // Nonce 15
    const nonce15 = '0x' + '0'.repeat(63) + 'f';
    const result15 = tracker.validateAndRecord(sender, messageType, nonce15);
    expect(result15.valid).toBe(true);
  });

  it('should reject duplicate nonce (exact replay)', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType = 'test.message';
    const nonce = '0x' + '0'.repeat(63) + '5';

    // First use - accepted
    const result1 = tracker.validateAndRecord(sender, messageType, nonce);
    expect(result1.valid).toBe(true);

    // Duplicate - rejected
    const result2 = tracker.validateAndRecord(sender, messageType, nonce);
    expect(result2.valid).toBe(false);
    expect(result2.reason).toContain('Nonce replay detected');
  });

  it('should track nonce count correctly', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType = 'test.message';

    expect(tracker.getNonceCount(sender, messageType)).toBe(0);

    tracker.validateAndRecord(sender, messageType, '0x' + '0'.repeat(63) + '1');
    expect(tracker.getNonceCount(sender, messageType)).toBe(1);

    tracker.validateAndRecord(sender, messageType, '0x' + '0'.repeat(63) + '2');
    expect(tracker.getNonceCount(sender, messageType)).toBe(2);

    tracker.validateAndRecord(sender, messageType, '0x' + '0'.repeat(63) + '3');
    expect(tracker.getNonceCount(sender, messageType)).toBe(3);
  });

  it('should cleanup old nonces', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType = 'test.message';

    // Add 10 nonces
    for (let i = 1; i <= 10; i++) {
      const nonce = '0x' + '0'.repeat(64 - i.toString(16).length) + i.toString(16);
      tracker.validateAndRecord(sender, messageType, nonce);
    }

    expect(tracker.getNonceCount(sender, messageType)).toBe(10);

    // Cleanup, keep only last 5
    tracker.cleanup(sender, messageType, 5);

    expect(tracker.getNonceCount(sender, messageType)).toBe(5);

    // Oldest nonces should be removed
    expect(tracker.hasBeenUsed(sender, messageType, '0x' + '0'.repeat(63) + '1')).toBe(false);
    expect(tracker.hasBeenUsed(sender, messageType, '0x' + '0'.repeat(63) + '6')).toBe(true);
  });

  it('should compute highest nonce correctly', () => {
    const sender = `did:ethr:${signer1.address}`;
    const messageType = 'test.message';

    // Add nonces out of order
    tracker.validateAndRecord(sender, messageType, '0x' + '0'.repeat(63) + '5');
    tracker.validateAndRecord(sender, messageType, '0x' + '0'.repeat(63) + '3');
    tracker.validateAndRecord(sender, messageType, '0x' + '0'.repeat(63) + 'a'); // 10

    const highestNonce = tracker.getHighestNonce(sender, messageType);
    expect(highestNonce).toBe('0x' + '0'.repeat(63) + 'a'); // 10 is highest
  });
});

describe('MessageSigner - Nonce Replay Attack Prevention', () => {
  let messageSigner: MessageSigner;
  let nonceTracker: InMemoryReceivedNonceTracker;

  beforeEach(async () => {
    nonceTracker = new InMemoryReceivedNonceTracker();
    messageSigner = new MessageSigner(signer1, nonceTracker);
    await messageSigner.initDomain(TEST_KERNEL_ADDRESS, 84532);
  });

  it('should accept message with valid nonce on first verification', async () => {
    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1',
      data: { test: 'value' }
    };

    const signature = await messageSigner.signMessage(message);
    const isValid = await messageSigner.verifySignature(message, signature);

    expect(isValid).toBe(true);
  });

  it('should reject replayed message (same nonce twice)', async () => {
    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1',
      data: { test: 'value' }
    };

    const signature = await messageSigner.signMessage(message);

    // First verification - accepted
    const isValid1 = await messageSigner.verifySignature(message, signature);
    expect(isValid1).toBe(true);

    // Second verification (replay) - rejected
    const isValid2 = await messageSigner.verifySignature(message, signature);
    expect(isValid2).toBe(false);
  });

  it('should reject old nonce replay attack', async () => {
    const sender = `did:ethr:${signer1.address}`;

    // Send message with nonce 10
    const message10: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: sender,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + 'a', // nonce 10
      data: { test: 'value10' }
    };

    const signature10 = await messageSigner.signMessage(message10);
    const isValid10 = await messageSigner.verifySignature(message10, signature10);
    expect(isValid10).toBe(true);

    // Attempt to send message with nonce 5 (old replay)
    const message5: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: sender,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '5', // nonce 5 (old)
      data: { test: 'value5' }
    };

    // Create fresh MessageSigner to sign with signer1 (to get valid signature)
    const tempSigner = new MessageSigner(signer1);
    await tempSigner.initDomain(TEST_KERNEL_ADDRESS, 84532);
    const signature5 = await tempSigner.signMessage(message5);

    // Verify with tracker-enabled MessageSigner - should reject
    const isValid5 = await messageSigner.verifySignature(message5, signature5);
    expect(isValid5).toBe(false);
  });

  it('should accept monotonically increasing nonces', async () => {
    const sender = `did:ethr:${signer1.address}`;

    for (let i = 1; i <= 5; i++) {
      const message: ACTPMessage = {
        type: 'test.message',
        version: '1.0.0',
        from: sender,
        to: `did:ethr:${signer2.address}`,
        timestamp: Math.floor(Date.now() / 1000),
        nonce: '0x' + '0'.repeat(64 - i.toString(16).length) + i.toString(16),
        data: { test: `value${i}` }
      };

      const signature = await messageSigner.signMessage(message);
      const isValid = await messageSigner.verifySignature(message, signature);

      expect(isValid).toBe(true);
    }
  });

  it('should isolate nonces by sender (cross-sender replay protection)', async () => {
    // Create tracker-enabled signers for both
    const nonceTracker1 = new InMemoryReceivedNonceTracker();
    const signer1MessageSigner = new MessageSigner(signer1, nonceTracker1);
    await signer1MessageSigner.initDomain(TEST_KERNEL_ADDRESS, 84532);

    const sender1 = `did:ethr:${signer1.address}`;
    const sender2 = `did:ethr:${signer2.address}`;

    // Sender 1 sends message with nonce 1
    const message1: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: sender1,
      to: sender2,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1',
      data: { from: 'sender1' }
    };

    const signature1 = await signer1MessageSigner.signMessage(message1);
    const isValid1 = await signer1MessageSigner.verifySignature(message1, signature1);
    expect(isValid1).toBe(true);

    // Sender 2 can send message with same nonce 1 (different sender)
    const message2: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: sender2,
      to: sender1,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1', // Same nonce, different sender
      data: { from: 'sender2' }
    };

    const signer2MessageSigner = new MessageSigner(signer2, nonceTracker1);
    await signer2MessageSigner.initDomain(TEST_KERNEL_ADDRESS, 84532);
    const signature2 = await signer2MessageSigner.signMessage(message2);
    const isValid2 = await signer1MessageSigner.verifySignature(message2, signature2);
    expect(isValid2).toBe(true);
  });

  it('should throw descriptive error for replay attack (verifySignatureOrThrow)', async () => {
    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1',
      data: { test: 'value' }
    };

    const signature = await messageSigner.signMessage(message);

    // First verification - succeeds
    await expect(messageSigner.verifySignatureOrThrow(message, signature)).resolves.not.toThrow();

    // Second verification (replay) - throws
    await expect(messageSigner.verifySignatureOrThrow(message, signature))
      .rejects
      .toThrow(/Nonce replay attack detected/);
  });

  it('should work without nonce tracker (backward compatibility)', async () => {
    // Create MessageSigner WITHOUT nonce tracker
    const signerWithoutTracker = new MessageSigner(signer1);
    await signerWithoutTracker.initDomain(TEST_KERNEL_ADDRESS, 84532);

    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1',
      data: { test: 'value' }
    };

    const signature = await signerWithoutTracker.signMessage(message);

    // Without tracker, same message can be verified multiple times
    const isValid1 = await signerWithoutTracker.verifySignature(message, signature);
    expect(isValid1).toBe(true);

    const isValid2 = await signerWithoutTracker.verifySignature(message, signature);
    expect(isValid2).toBe(true); // Still valid (no replay protection)
  });

  it('should handle invalid signature with nonce tracker enabled', async () => {
    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1',
      data: { test: 'value' }
    };

    // Sign with signer1 but claim it's from signer2 (invalid signature)
    const invalidMessage = { ...message, from: `did:ethr:${signer2.address}` };
    const signature = await messageSigner.signMessage(message);

    // Should reject due to invalid signature (before nonce check)
    const isValid = await messageSigner.verifySignature(invalidMessage, signature);
    expect(isValid).toBe(false);

    // Nonce should NOT be recorded for invalid signatures
    expect(nonceTracker.getHighestNonce(`did:ethr:${signer2.address}`, 'test.message')).toBeNull();
  });
});

describe('ReceivedNonceTracker - Factory Function', () => {
  it('should create memory-efficient tracker by default', () => {
    const tracker = createReceivedNonceTracker();
    expect(tracker).toBeInstanceOf(InMemoryReceivedNonceTracker);
  });

  it('should create memory-efficient tracker explicitly', () => {
    const tracker = createReceivedNonceTracker('memory-efficient');
    expect(tracker).toBeInstanceOf(InMemoryReceivedNonceTracker);
  });

  it('should create set-based tracker', () => {
    const tracker = createReceivedNonceTracker('set-based');
    expect(tracker).toBeInstanceOf(SetBasedReceivedNonceTracker);
  });
});
