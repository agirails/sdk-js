/**
 * Integration Tests - SDK Logic (No Blockchain Required)
 * 
 * These tests validate SDK functionality without needing deployed contracts.
 */

import { keccak256, toUtf8Bytes, hexlify, Wallet, randomBytes, HDNodeWallet } from 'ethers';
import { ProofGenerator } from '../protocol/ProofGenerator';
import { MessageSigner } from '../protocol/MessageSigner';
import { State, StateMachine } from '../types/state';
import { ACTPMessage } from '../types/message';

describe('SDK Integration Tests', () => {
  let wallet: HDNodeWallet;
  let proofGenerator: ProofGenerator;
  let messageSigner: MessageSigner;

  beforeAll(async () => {
    // Create test wallet
    wallet = Wallet.createRandom();
    proofGenerator = new ProofGenerator();
    messageSigner = new MessageSigner(wallet);

    // Initialize EIP-712 domain for message signing
    const mockKernelAddress = '0x' + '1'.repeat(40);
    await messageSigner.initDomain(mockKernelAddress);
  });

  describe('Complete Transaction Lifecycle (Mock)', () => {
    it('should follow complete state machine flow', () => {
      // Start state
      let currentState = State.INITIATED;
      expect(StateMachine.isTerminalState(currentState)).toBe(false);

      // INITIATED → QUOTED
      expect(StateMachine.isValidTransition(currentState, State.QUOTED)).toBe(true);
      currentState = State.QUOTED;

      // QUOTED → COMMITTED
      expect(StateMachine.isValidTransition(currentState, State.COMMITTED)).toBe(true);
      currentState = State.COMMITTED;

      // COMMITTED → IN_PROGRESS
      expect(StateMachine.isValidTransition(currentState, State.IN_PROGRESS)).toBe(true);
      currentState = State.IN_PROGRESS;

      // IN_PROGRESS → DELIVERED
      expect(StateMachine.isValidTransition(currentState, State.DELIVERED)).toBe(true);
      currentState = State.DELIVERED;

      // DELIVERED → SETTLED
      expect(StateMachine.isValidTransition(currentState, State.SETTLED)).toBe(true);
      currentState = State.SETTLED;

      // Final state
      expect(StateMachine.isTerminalState(currentState)).toBe(true);
    });

    it('should reject invalid state transitions', () => {
      // Can't jump from INITIATED to SETTLED
      expect(StateMachine.isValidTransition(State.INITIATED, State.SETTLED)).toBe(false);

      // Can't go backwards from SETTLED
      expect(StateMachine.isValidTransition(State.SETTLED, State.INITIATED)).toBe(false);

      // Can't transition from terminal state
      expect(StateMachine.isValidTransition(State.CANCELLED, State.INITIATED)).toBe(false);
    });
  });

  describe('Delivery Proof Generation & Verification', () => {
    const txId = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const deliverable = 'This is the completed translation work. Lorem ipsum dolor sit amet.';

    it('should generate and verify delivery proof', () => {
      // Generate proof
      const proof = proofGenerator.generateDeliveryProof({
        txId,
        deliverable,
        metadata: {
          language: 'es',
          wordCount: 100
        }
      });

      expect(proof.txId).toBe(txId);
      expect(proof.contentHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(proof.metadata.language).toBe('es');

      // Verify deliverable
      const isValid = proofGenerator.verifyDeliverable(deliverable, proof.contentHash);
      expect(isValid).toBe(true);

      // Wrong deliverable should fail
      const isInvalid = proofGenerator.verifyDeliverable('wrong content', proof.contentHash);
      expect(isInvalid).toBe(false);
    });

    it('should encode and decode proof for on-chain submission', () => {
      const proof = proofGenerator.generateDeliveryProof({
        txId,
        deliverable
      });

      // Encode for on-chain
      const encoded = proofGenerator.encodeProof(proof);
      expect(encoded).toMatch(/^0x[a-f0-9]+$/);

      // Decode
      const decoded = proofGenerator.decodeProof(encoded);
      expect(decoded.txId).toBe(proof.txId);
      expect(decoded.contentHash).toBe(proof.contentHash);
      expect(decoded.timestamp).toBe(proof.timestamp);
    });
  });

  describe('Message Signing & Verification', () => {
    it('should sign and verify ACTP messages', async () => {
      const message: ACTPMessage = {
        type: 'quote.request',
        version: '1.0',
        from: messageSigner.addressToDID(wallet.address),
        to: messageSigner.addressToDID('0x' + '1'.repeat(40)),
        timestamp: Date.now(),
        nonce: hexlify(randomBytes(32)),
        serviceRequest: {
          capabilityType: 'translation',
          parameters: {}
        }
      };

      // Sign
      const signature = await messageSigner.signMessage(message);
      expect(signature).toMatch(/^0x[a-f0-9]{130}$/);

      // Verify
      const isValid = await messageSigner.verifySignature(message, signature);
      expect(isValid).toBe(true);
    });

    it('should reject invalid signatures', async () => {
      const message: ACTPMessage = {
        type: 'quote.request',
        version: '1.0',
        from: messageSigner.addressToDID(wallet.address),
        to: messageSigner.addressToDID('0x' + '1'.repeat(40)),
        timestamp: Date.now(),
        nonce: hexlify(randomBytes(32))
      };

      // Sign with this wallet
      const signature = await messageSigner.signMessage(message);

      // Modify message (tamper)
      message.timestamp = Date.now() + 1000;

      // Verification should fail
      const isValid = await messageSigner.verifySignature(message, signature);
      expect(isValid).toBe(false);
    });

    it('should convert between DID and address', () => {
      const address = wallet.address;
      const did = messageSigner.addressToDID(address);

      expect(did).toBe(`did:ethr:${address}`);

      // DID resolution would happen here in real implementation
      expect(did).toMatch(/^did:ethr:0x[a-fA-F0-9]{40}$/);
    });
  });

  describe('Content Hashing (Keccak256)', () => {
    it('should produce consistent hashes', () => {
      const content = 'Test content for hashing';

      const hash1 = proofGenerator.hashContent(content);
      const hash2 = proofGenerator.hashContent(content);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', () => {
      const content1 = 'Content A';
      const content2 = 'Content B';

      const hash1 = proofGenerator.hashContent(content1);
      const hash2 = proofGenerator.hashContent(content2);

      expect(hash1).not.toBe(hash2);
    });

    it('should handle binary data', () => {
      const buffer = Buffer.from([1, 2, 3, 4, 5]);
      const hash = proofGenerator.hashContent(buffer);

      expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
    });

    it('should match ethers.js keccak256', () => {
      const content = 'Hello, ACTP!';
      const contentBytes = toUtf8Bytes(content);

      const sdkHash = proofGenerator.hashContent(content);
      const ethersHash = keccak256(contentBytes);

      expect(sdkHash).toBe(ethersHash);
    });
  });

  describe('Error Scenarios', () => {
    it('should throw on invalid state transitions', () => {
      expect(() => {
        StateMachine.validateTransition(State.INITIATED, State.SETTLED);
      }).toThrow('Invalid state transition');
    });

    it('should identify terminal states correctly', () => {
      expect(StateMachine.isTerminalState(State.SETTLED)).toBe(true);
      expect(StateMachine.isTerminalState(State.CANCELLED)).toBe(true);
      expect(StateMachine.isTerminalState(State.IN_PROGRESS)).toBe(false);
    });

    it('should list valid next states', () => {
      const nextStates = StateMachine.getNextValidStates(State.DELIVERED);
      expect(nextStates).toContain(State.SETTLED);
      expect(nextStates).toContain(State.DISPUTED);
      expect(nextStates).toHaveLength(2);
    });
  });

  describe('Full Mock Transaction Flow', () => {
    it('should simulate complete transaction', async () => {
      console.log('\n=== Mock Transaction Flow ===\n');

      // 1. Create transaction (INITIATED)
      const txId = hexlify(randomBytes(32));
      let state = State.INITIATED;
      console.log(`1. Transaction created: ${txId}`);
      console.log(`   State: ${State[state]}`);

      // 2. Quote provided (QUOTED)
      state = State.QUOTED;
      console.log(`\n2. Quote provided`);
      console.log(`   State: ${State[state]}`);

      // 3. Funds escrowed (COMMITTED)
      state = State.COMMITTED;
      console.log(`\n3. Funds escrowed`);
      console.log(`   State: ${State[state]}`);

      // 4. Work started (IN_PROGRESS)
      state = State.IN_PROGRESS;
      console.log(`\n4. Work started`);
      console.log(`   State: ${State[state]}`);

      // 5. Work delivered (DELIVERED)
      const deliverable = 'Completed translation: Hola, mundo!';
      const proof = proofGenerator.generateDeliveryProof({
        txId,
        deliverable,
        metadata: { language: 'es', wordCount: 3 }
      });

      state = State.DELIVERED;
      console.log(`\n5. Work delivered`);
      console.log(`   State: ${State[state]}`);
      console.log(`   Content Hash: ${proof.contentHash}`);

      // 6. Verify delivery
      const isValid = proofGenerator.verifyDeliverable(deliverable, proof.contentHash);
      console.log(`\n6. Delivery verified: ${isValid}`);

      // 7. Settle transaction (SETTLED)
      state = State.SETTLED;
      console.log(`\n7. Transaction settled`);
      console.log(`   State: ${State[state]}`);
      console.log(`   Terminal: ${StateMachine.isTerminalState(state)}`);

      // Assertions
      expect(state).toBe(State.SETTLED);
      expect(StateMachine.isTerminalState(state)).toBe(true);
      expect(isValid).toBe(true);

      console.log('\n=== Transaction Complete ===\n');
    });
  });
});

