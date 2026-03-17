/**
 * SessionStore — Commerce session tracking and traceability.
 *
 * Every negotiation carries a canonical `commerce_session_id` (UUID).
 * No createTransaction() is allowed without a session ID.
 *
 * Persisted to `.actp/sessions.json` using atomic writes.
 */

import { randomUUID } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface SessionMapping {
  commerce_session_id: string;
  actp_tx_id?: string;
  task: string;
  candidates_tried: string[]; // slugs of providers attempted
  selected_provider?: string;
  status: 'active' | 'committed' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  created_at: string;
  updated_at: string;
}

interface SessionsFile {
  version: 1;
  sessions: SessionMapping[];
}

// ============================================================================
// SessionStore
// ============================================================================

export class SessionStore {
  private actpDir: string;
  private sessions: Map<string, SessionMapping>;

  constructor(actpDir?: string) {
    this.actpDir = actpDir ?? (process.env.ACTP_DIR || join(process.cwd(), '.actp'));
    this.sessions = new Map();
    this.load();
  }

  /**
   * Create a new commerce session.
   */
  create(task: string): SessionMapping {
    const session: SessionMapping = {
      commerce_session_id: randomUUID(),
      task,
      candidates_tried: [],
      status: 'active',
      attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.sessions.set(session.commerce_session_id, session);
    this.save();
    return session;
  }

  /**
   * Get a session by ID.
   */
  get(sessionId: string): SessionMapping | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Find a session by ACTP transaction ID.
   */
  findByTxId(txId: string): SessionMapping | undefined {
    for (const session of this.sessions.values()) {
      if (session.actp_tx_id === txId) return session;
    }
    return undefined;
  }

  /**
   * Record a candidate attempt (provider tried).
   */
  recordAttempt(sessionId: string, providerSlug: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    if (!session.candidates_tried.includes(providerSlug)) {
      session.candidates_tried.push(providerSlug);
    }
    session.attempts++;
    session.updated_at = new Date().toISOString();
    this.save();
  }

  /**
   * Link a session to an ACTP transaction.
   */
  linkTransaction(sessionId: string, txId: string, providerSlug: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.actp_tx_id = txId;
    session.selected_provider = providerSlug;
    session.status = 'committed';
    session.updated_at = new Date().toISOString();
    this.save();
  }

  /**
   * Update session status.
   */
  updateStatus(sessionId: string, status: SessionMapping['status']): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.status = status;
    session.updated_at = new Date().toISOString();
    this.save();
  }

  /**
   * List all sessions, optionally filtered by status.
   */
  list(status?: SessionMapping['status']): SessionMapping[] {
    const all = Array.from(this.sessions.values());
    if (!status) return all;
    return all.filter((s) => s.status === status);
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  private getFilePath(): string {
    return join(this.actpDir, 'sessions.json');
  }

  private load(): void {
    const path = this.getFilePath();
    try {
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, 'utf8')) as SessionsFile;
      if (raw.version !== 1) return;
      for (const session of raw.sessions) {
        this.sessions.set(session.commerce_session_id, session);
      }
      // Prune terminal sessions older than 30 days
      this.pruneOldSessions();
    } catch {
      // Corrupted file — start fresh
    }
  }

  private pruneOldSessions(maxAgeDays = 30): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const terminalStatuses = ['completed', 'failed', 'cancelled'];
    let pruned = false;
    for (const [id, session] of this.sessions) {
      if (terminalStatuses.includes(session.status) && new Date(session.updated_at) < cutoff) {
        this.sessions.delete(id);
        pruned = true;
      }
    }
    if (pruned) this.save();
  }

  private save(): void {
    // Ensure directory exists
    if (existsSync(this.actpDir)) {
      const stat = lstatSync(this.actpDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Security: ${this.actpDir} is not a real directory`);
      }
    } else {
      mkdirSync(this.actpDir, { recursive: true, mode: 0o700 });
    }

    const data: SessionsFile = {
      version: 1,
      sessions: Array.from(this.sessions.values()),
    };

    const filePath = this.getFilePath();

    // Guard against target file being a symlink
    if (existsSync(filePath)) {
      const fileStat = lstatSync(filePath);
      if (fileStat.isSymbolicLink()) {
        throw new Error(`Security: ${filePath} is a symlink — refusing to overwrite`);
      }
    }

    const tmpPath = filePath + '.tmp';

    // Guard against tmp file being a symlink
    if (existsSync(tmpPath)) {
      const tmpStat = lstatSync(tmpPath);
      if (tmpStat.isSymbolicLink()) {
        throw new Error(`Security: ${tmpPath} is a symlink — refusing to write`);
      }
    }

    // Atomic write
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmpPath, filePath);
  }
}
