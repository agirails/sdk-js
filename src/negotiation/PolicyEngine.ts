/**
 * PolicyEngine — Hard guardrails for autonomous negotiation.
 *
 * 5 non-negotiable checks before any escrow commitment:
 * 1. unit_price <= max_unit_price
 * 2. committed_today + projected_cost <= max_daily_spend
 * 3. provider reputation >= min_reputation (if defined) — unknown = fail
 * 4. quote not expired (within quote_ttl)
 * 5. valid commerce_session_id
 *
 * Daily budget ledger persisted to `.actp/budget-ledger.json`
 * using atomic write pattern (write-to-tmp + renameSync).
 * Budget resets at UTC midnight.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface BuyerPolicy {
  task: string;
  constraints: {
    max_unit_price: { amount: number; currency: string; unit: string };
    max_daily_spend: { amount: number; currency: string };
  };
  negotiation: {
    rounds_max: number;
    quote_ttl: string; // e.g. "15m"
  };
  selection: {
    min_reputation?: number;
    prioritize: ('quality' | 'price' | 'speed' | 'reliability')[];
    weights?: { quality?: number; price?: number; speed?: number; reliability?: number };
  };
}

export interface QuoteOffer {
  provider: string;
  unit_price: number;
  currency: string;
  unit: string;
  /** Total projected cost for this job (unit_price * quantity). Falls back to unit_price if omitted. */
  total_price?: number;
  expires_at?: number; // unix timestamp
  reputation_score?: number;
  commerce_session_id?: string;
}

export type PolicyViolation =
  | { rule: 'max_unit_price'; detail: string }
  | { rule: 'max_daily_spend'; detail: string }
  | { rule: 'min_reputation'; detail: string }
  | { rule: 'quote_expired'; detail: string }
  | { rule: 'missing_session_id'; detail: string };

export interface PolicyResult {
  allowed: boolean;
  violations: PolicyViolation[];
}

/** Single entry in the daily budget ledger */
export interface BudgetEntry {
  commerce_session_id: string;
  actp_tx_id?: string;
  amount: number;
  currency: string;
  status: 'reserved' | 'committed' | 'released';
  created_at: string;
}

/** Persisted budget ledger file */
interface BudgetLedgerFile {
  version: 1;
  date: string; // YYYY-MM-DD (UTC)
  entries: BudgetEntry[];
}

// ============================================================================
// PolicyEngine
// ============================================================================

export class PolicyEngine {
  private policy: BuyerPolicy;
  private actpDir: string;
  private ledger: BudgetLedgerFile;

  constructor(policy: BuyerPolicy, actpDir?: string) {
    this.policy = policy;
    this.actpDir = actpDir ?? (process.env.ACTP_DIR || join(process.cwd(), '.actp'));
    this.ledger = this.loadLedger();
  }

  /**
   * Validate a quote offer against all 5 policy guardrails.
   */
  validate(offer: QuoteOffer): PolicyResult {
    const violations: PolicyViolation[] = [];

    // 0. Sanity check — reject NaN, negative, non-finite prices
    if (!Number.isFinite(offer.unit_price) || offer.unit_price < 0) {
      return {
        allowed: false,
        violations: [{ rule: 'max_unit_price', detail: `Invalid unit_price: ${offer.unit_price} (must be finite and >= 0)` }],
      };
    }
    if (offer.total_price != null && (!Number.isFinite(offer.total_price) || offer.total_price < 0)) {
      return {
        allowed: false,
        violations: [{ rule: 'max_daily_spend', detail: `Invalid total_price: ${offer.total_price} (must be finite and >= 0)` }],
      };
    }

    // 1. Unit price check (with currency/unit consistency enforcement)
    if (offer.currency.toUpperCase() !== this.policy.constraints.max_unit_price.currency.toUpperCase()) {
      violations.push({
        rule: 'max_unit_price',
        detail: `Currency mismatch: offer is ${offer.currency}, policy requires ${this.policy.constraints.max_unit_price.currency}`,
      });
    } else if (offer.unit !== this.policy.constraints.max_unit_price.unit) {
      violations.push({
        rule: 'max_unit_price',
        detail: `Unit mismatch: offer is per-${offer.unit}, policy requires per-${this.policy.constraints.max_unit_price.unit}`,
      });
    } else if (offer.unit_price > this.policy.constraints.max_unit_price.amount) {
      violations.push({
        rule: 'max_unit_price',
        detail: `${offer.unit_price} ${offer.currency}/${offer.unit} exceeds max ${this.policy.constraints.max_unit_price.amount} ${this.policy.constraints.max_unit_price.currency}/${this.policy.constraints.max_unit_price.unit}`,
      });
    }

    // 2. Daily spend check (with currency consistency)
    const projectedCost = offer.total_price ?? offer.unit_price;
    if (offer.currency.toUpperCase() !== this.policy.constraints.max_daily_spend.currency.toUpperCase()) {
      violations.push({
        rule: 'max_daily_spend',
        detail: `Currency mismatch: offer is ${offer.currency}, daily spend limit is ${this.policy.constraints.max_daily_spend.currency}`,
      });
    } else {
      const committedToday = this.getCommittedToday();
      const projectedTotal = committedToday + projectedCost;
      if (projectedTotal > this.policy.constraints.max_daily_spend.amount) {
        violations.push({
          rule: 'max_daily_spend',
          detail: `Committed today: ${committedToday}, projected: ${projectedTotal}, max: ${this.policy.constraints.max_daily_spend.amount} ${this.policy.constraints.max_daily_spend.currency}`,
        });
      }
    }

    // 3. Reputation check — unknown (missing score) = fail when min_reputation is set
    if (this.policy.selection.min_reputation != null) {
      if (
        offer.reputation_score == null ||
        offer.reputation_score < this.policy.selection.min_reputation
      ) {
        violations.push({
          rule: 'min_reputation',
          detail: offer.reputation_score == null
            ? `Provider reputation unknown — min ${this.policy.selection.min_reputation} required`
            : `Provider reputation ${offer.reputation_score} below minimum ${this.policy.selection.min_reputation}`,
        });
      }
    }

    // 4. Quote expiry check
    if (offer.expires_at != null && offer.expires_at <= Math.floor(Date.now() / 1000)) {
      violations.push({
        rule: 'quote_expired',
        detail: `Quote expired at ${new Date(offer.expires_at * 1000).toISOString()}`,
      });
    }

    // 5. Session ID check
    if (!offer.commerce_session_id) {
      violations.push({
        rule: 'missing_session_id',
        detail: 'No commerce_session_id provided',
      });
    }

    return {
      allowed: violations.length === 0,
      violations,
    };
  }

  /**
   * Reserve budget for a pending commitment.
   * Throws if the reservation would exceed max_daily_spend.
   */
  reserve(sessionId: string, amount: number, currency: string): void {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`Invalid reserve amount: ${amount} (must be finite and >= 0)`);
    }

    const policyCurrency = this.policy.constraints.max_daily_spend.currency;
    if (currency.toUpperCase() !== policyCurrency.toUpperCase()) {
      throw new Error(
        `Currency mismatch in reserve: ${currency} does not match policy currency ${policyCurrency}`
      );
    }

    this.ensureLedgerCurrent();

    // Enforce budget at reservation time (defense in depth — not just in validate())
    const committedToday = this.getCommittedToday();
    if (committedToday + amount > this.policy.constraints.max_daily_spend.amount) {
      throw new Error(
        `Budget exceeded: reserving ${amount} ${currency} would exceed daily limit ` +
        `${this.policy.constraints.max_daily_spend.amount} ${this.policy.constraints.max_daily_spend.currency} ` +
        `(already committed: ${committedToday})`
      );
    }

    this.ledger.entries.push({
      commerce_session_id: sessionId,
      amount,
      currency,
      status: 'reserved',
      created_at: new Date().toISOString(),
    });
    this.saveLedger();
  }

  /**
   * Commit a reservation (after escrow linked).
   */
  commit(sessionId: string, actpTxId: string): void {
    const entry = this.ledger.entries.find(
      (e) => e.commerce_session_id === sessionId && e.status === 'reserved'
    );
    if (entry) {
      entry.status = 'committed';
      entry.actp_tx_id = actpTxId;
      this.saveLedger();
    }
  }

  /**
   * Release a reservation (after cancel/dispute).
   */
  release(sessionId: string): void {
    const entry = this.ledger.entries.find(
      (e) => e.commerce_session_id === sessionId && (e.status === 'reserved' || e.status === 'committed')
    );
    if (entry) {
      entry.status = 'released';
      this.saveLedger();
    }
  }

  /**
   * Get total committed + reserved exposure for today.
   */
  getCommittedToday(): number {
    this.ensureLedgerCurrent();
    return this.ledger.entries
      .filter((e) => e.status === 'reserved' || e.status === 'committed')
      .reduce((sum, e) => sum + e.amount, 0);
  }

  /**
   * Parse a TTL string like "15m" or "2h" into seconds.
   */
  static parseTtl(ttl: string): number {
    const match = ttl.match(/^(\d+)(s|m|h)$/);
    if (!match) throw new Error(`Invalid TTL format: ${ttl}`);
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      default: throw new Error(`Invalid TTL unit: ${match[2]}`);
    }
  }

  /**
   * Get the quote TTL deadline (unix timestamp).
   */
  getQuoteDeadline(): number {
    const ttlSeconds = PolicyEngine.parseTtl(this.policy.negotiation.quote_ttl);
    return Math.floor(Date.now() / 1000) + ttlSeconds;
  }

  // ============================================================================
  // Budget Ledger Persistence
  // ============================================================================

  private getLedgerPath(): string {
    return join(this.actpDir, 'budget-ledger.json');
  }

  private todayString(): string {
    // UTC — daily budget resets at UTC midnight.
    return new Date().toISOString().split('T')[0];
  }

  private ensureLedgerCurrent(): void {
    const today = this.todayString();
    if (this.ledger.date !== today) {
      this.ledger = { version: 1, date: today, entries: [] };
      this.saveLedger();
    }
  }

  private loadLedger(): BudgetLedgerFile {
    const path = this.getLedgerPath();
    const today = this.todayString();

    try {
      if (!existsSync(path)) {
        return { version: 1, date: today, entries: [] };
      }
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (raw.version !== 1 || raw.date !== today) {
        return { version: 1, date: today, entries: [] };
      }
      return raw as BudgetLedgerFile;
    } catch {
      return { version: 1, date: today, entries: [] };
    }
  }

  private ensureDir(): void {
    if (existsSync(this.actpDir)) {
      const stat = lstatSync(this.actpDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Security: ${this.actpDir} is not a real directory`);
      }
    } else {
      mkdirSync(this.actpDir, { recursive: true, mode: 0o700 });
    }
  }

  private saveLedger(): void {
    this.ensureDir();

    const filePath = this.getLedgerPath();

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
    writeFileSync(tmpPath, JSON.stringify(this.ledger, null, 2), { mode: 0o600 });
    renameSync(tmpPath, filePath);
  }
}
