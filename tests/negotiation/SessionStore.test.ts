import { SessionStore, SessionMapping } from '../../src/negotiation/SessionStore';
import { mkdirSync, rmSync, existsSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_DIR = join(tmpdir(), `session-store-test-${process.pid}`);

// ============================================================================
// Tests
// ============================================================================

describe('SessionStore', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  describe('CRUD operations', () => {
    it('creates a session with UUID', () => {
      const store = new SessionStore(TEST_DIR);
      const session = store.create('translation.fr_en');
      expect(session.commerce_session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(session.task).toBe('translation.fr_en');
      expect(session.status).toBe('active');
      expect(session.attempts).toBe(0);
      expect(session.candidates_tried).toHaveLength(0);
    });

    it('retrieves session by ID', () => {
      const store = new SessionStore(TEST_DIR);
      const created = store.create('task-1');
      const retrieved = store.get(created.commerce_session_id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.task).toBe('task-1');
    });

    it('returns undefined for unknown ID', () => {
      const store = new SessionStore(TEST_DIR);
      expect(store.get('nonexistent')).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Attempt tracking
  // --------------------------------------------------------------------------

  describe('attempt tracking', () => {
    it('records candidate attempts', () => {
      const store = new SessionStore(TEST_DIR);
      const session = store.create('task-1');
      store.recordAttempt(session.commerce_session_id, 'provider-a');
      store.recordAttempt(session.commerce_session_id, 'provider-b');

      const updated = store.get(session.commerce_session_id)!;
      expect(updated.candidates_tried).toEqual(['provider-a', 'provider-b']);
      expect(updated.attempts).toBe(2);
    });

    it('deduplicates candidate slugs', () => {
      const store = new SessionStore(TEST_DIR);
      const session = store.create('task-1');
      store.recordAttempt(session.commerce_session_id, 'provider-a');
      store.recordAttempt(session.commerce_session_id, 'provider-a');

      const updated = store.get(session.commerce_session_id)!;
      expect(updated.candidates_tried).toEqual(['provider-a']);
      expect(updated.attempts).toBe(2); // attempts still incremented
    });

    it('throws on unknown session', () => {
      const store = new SessionStore(TEST_DIR);
      expect(() => store.recordAttempt('nonexistent', 'p1')).toThrow('Session not found');
    });
  });

  // --------------------------------------------------------------------------
  // Transaction linking
  // --------------------------------------------------------------------------

  describe('transaction linking', () => {
    it('links ACTP tx and sets committed status', () => {
      const store = new SessionStore(TEST_DIR);
      const session = store.create('task-1');
      store.linkTransaction(session.commerce_session_id, 'tx-abc', 'provider-x');

      const updated = store.get(session.commerce_session_id)!;
      expect(updated.actp_tx_id).toBe('tx-abc');
      expect(updated.selected_provider).toBe('provider-x');
      expect(updated.status).toBe('committed');
    });

    it('finds session by tx ID', () => {
      const store = new SessionStore(TEST_DIR);
      const session = store.create('task-1');
      store.linkTransaction(session.commerce_session_id, 'tx-123', 'p1');

      const found = store.findByTxId('tx-123');
      expect(found).toBeDefined();
      expect(found!.commerce_session_id).toBe(session.commerce_session_id);
    });

    it('returns undefined for unknown tx ID', () => {
      const store = new SessionStore(TEST_DIR);
      expect(store.findByTxId('nonexistent')).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Status updates
  // --------------------------------------------------------------------------

  describe('status updates', () => {
    it('updates status', () => {
      const store = new SessionStore(TEST_DIR);
      const session = store.create('task-1');
      store.updateStatus(session.commerce_session_id, 'completed');

      const updated = store.get(session.commerce_session_id)!;
      expect(updated.status).toBe('completed');
    });

    it('throws on unknown session', () => {
      const store = new SessionStore(TEST_DIR);
      expect(() => store.updateStatus('nonexistent', 'failed')).toThrow('Session not found');
    });
  });

  // --------------------------------------------------------------------------
  // Listing and filtering
  // --------------------------------------------------------------------------

  describe('list', () => {
    it('lists all sessions', () => {
      const store = new SessionStore(TEST_DIR);
      store.create('task-1');
      store.create('task-2');
      expect(store.list()).toHaveLength(2);
    });

    it('filters by status', () => {
      const store = new SessionStore(TEST_DIR);
      const s1 = store.create('task-1');
      store.create('task-2');
      store.updateStatus(s1.commerce_session_id, 'completed');

      expect(store.list('active')).toHaveLength(1);
      expect(store.list('completed')).toHaveLength(1);
      expect(store.list('failed')).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  describe('persistence', () => {
    it('persists across instances', () => {
      const store1 = new SessionStore(TEST_DIR);
      const session = store1.create('task-1');
      store1.recordAttempt(session.commerce_session_id, 'p1');

      // New instance reads from disk
      const store2 = new SessionStore(TEST_DIR);
      const loaded = store2.get(session.commerce_session_id);
      expect(loaded).toBeDefined();
      expect(loaded!.task).toBe('task-1');
      expect(loaded!.candidates_tried).toEqual(['p1']);
    });
  });

  // --------------------------------------------------------------------------
  // Symlink protection
  // --------------------------------------------------------------------------

  describe('symlink protection', () => {
    it('rejects symlink .actp directory', () => {
      const symlinkDir = join(TEST_DIR, 'symlink-actp');
      const realDir = join(TEST_DIR, 'real-target');
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, symlinkDir);

      const store = new SessionStore(symlinkDir);
      expect(() => store.create('task-1')).toThrow('not a real directory');
    });

    it('rejects symlink target file', () => {
      const actpDir = join(TEST_DIR, '.actp');
      mkdirSync(actpDir, { recursive: true });
      const target = join(TEST_DIR, 'evil-target.json');
      writeFileSync(target, '{}');
      symlinkSync(target, join(actpDir, 'sessions.json'));

      const store = new SessionStore(actpDir);
      expect(() => store.create('task-1')).toThrow('symlink');
    });

    it('rejects symlink tmp file', () => {
      const actpDir = join(TEST_DIR, '.actp');
      mkdirSync(actpDir, { recursive: true });
      const target = join(TEST_DIR, 'evil-tmp.json');
      writeFileSync(target, '{}');
      symlinkSync(target, join(actpDir, 'sessions.json.tmp'));

      const store = new SessionStore(actpDir);
      expect(() => store.create('task-1')).toThrow('symlink');
    });
  });
});
