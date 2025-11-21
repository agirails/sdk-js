import { ProofGenerator } from '../protocol/ProofGenerator';

describe('ProofGenerator', () => {
  let proofGenerator: ProofGenerator;

  beforeEach(() => {
    proofGenerator = new ProofGenerator();
  });

  describe('hashContent', () => {
    it('should hash string content', () => {
      const content = 'Hello, ACTP!';
      const hash = proofGenerator.hashContent(content);

      expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(hash).toHaveLength(66); // 0x + 64 hex chars
    });

    it('should hash buffer content', () => {
      const content = Buffer.from('Hello, ACTP!');
      const hash = proofGenerator.hashContent(content);

      expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
    });

    it('should produce same hash for same content', () => {
      const content = 'Test content';
      const hash1 = proofGenerator.hashContent(content);
      const hash2 = proofGenerator.hashContent(content);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', () => {
      const hash1 = proofGenerator.hashContent('Content A');
      const hash2 = proofGenerator.hashContent('Content B');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('generateDeliveryProof', () => {
    it('should generate valid delivery proof', () => {
      const txId = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const deliverable = 'Completed translation work';

      const proof = proofGenerator.generateDeliveryProof({
        txId,
        deliverable,
        metadata: { language: 'es' }
      });

      expect(proof.txId).toBe(txId);
      expect(proof.contentHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(proof.timestamp).toBeGreaterThan(0);
      expect(proof.metadata.size).toBeGreaterThan(0);
      expect(proof.metadata.language).toBe('es');
    });

    it('should include default mimeType', () => {
      const proof = proofGenerator.generateDeliveryProof({
        txId: '0x1234',
        deliverable: 'test'
      });

      expect(proof.metadata.mimeType).toBe('application/octet-stream');
    });

    it('should use custom mimeType', () => {
      const proof = proofGenerator.generateDeliveryProof({
        txId: '0x1234',
        deliverable: 'test',
        metadata: { mimeType: 'text/plain' }
      });

      expect(proof.metadata.mimeType).toBe('text/plain');
    });
  });

  describe('verifyDeliverable', () => {
    it('should verify matching deliverable', () => {
      const deliverable = 'Test deliverable';
      const hash = proofGenerator.hashContent(deliverable);

      const isValid = proofGenerator.verifyDeliverable(deliverable, hash);
      expect(isValid).toBe(true);
    });

    it('should reject non-matching deliverable', () => {
      const deliverable = 'Test deliverable';
      const wrongHash = proofGenerator.hashContent('Wrong content');

      const isValid = proofGenerator.verifyDeliverable(deliverable, wrongHash);
      expect(isValid).toBe(false);
    });

    it('should be case-insensitive for hash comparison', () => {
      const deliverable = 'Test';
      const hash = proofGenerator.hashContent(deliverable);
      const upperHash = hash.toUpperCase();

      const isValid = proofGenerator.verifyDeliverable(deliverable, upperHash);
      expect(isValid).toBe(true);
    });
  });

  describe('encodeProof and decodeProof', () => {
    it('should encode and decode proof correctly', () => {
      const originalProof = proofGenerator.generateDeliveryProof({
        txId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        deliverable: 'test'
      });

      const encoded = proofGenerator.encodeProof(originalProof);
      const decoded = proofGenerator.decodeProof(encoded);

      expect(decoded.txId).toBe(originalProof.txId);
      expect(decoded.contentHash).toBe(originalProof.contentHash);
      expect(decoded.timestamp).toBe(originalProof.timestamp);
    });
  });
});


