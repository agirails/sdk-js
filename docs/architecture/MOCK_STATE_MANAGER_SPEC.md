# MockStateManager Technical Specification

**Version:** 1.0
**Date:** December 12, 2025
**Status:** Final
**Related ADR:** ADR-001 (Mock State Persistence Strategy)

---

## 1. Overview

The `MockStateManager` class is responsible for persisting mock blockchain state to disk, enabling state sharing across CLI commands, SDK library usage, and Dashboard.

**Key Responsibilities:**
- Load/save state from/to `.actp/mock-state.json`
- Atomic file operations (write to temp file, then rename)
- File locking to prevent concurrent access corruption
- Error recovery for corrupted state files

---

## 2. File Structure

```
project-root/
├── .actp/
│   ├── mock-state.json      # Persistent state
│   ├── mock-state.lock      # Lock file (managed by proper-lockfile)
│   └── config.json          # SDK configuration
```

---

## 3. State Schema

```typescript
export interface MockState {
  version: string;              // State schema version (e.g., "1.0")
  mode: 'mock';
  blockchain: {
    currentTime: number;        // Unix timestamp (seconds)
    blockNumber: number;
    chainId: number;            // 84532 for Base Sepolia
  };
  transactions: Record<string, MockTransaction>;
  escrows: Record<string, MockEscrow>;
  accounts: Record<string, MockAccount>;
}

export interface MockTransaction {
  id: string;
  requester: string;
  provider: string;
  amount: string;               // BigNumber as string (USDC wei, 6 decimals)
  state: TransactionState;      // INITIATED, COMMITTED, DELIVERED, etc.
  createdAt: number;            // Unix timestamp
  updatedAt: number;
  deadline: number;
  disputeWindow: number;
  escrowId: string | null;
  events: MockEvent[];
}

export interface MockEscrow {
  id: string;
  balance: string;              // BigNumber as string
  locked: boolean;
  transactions: string[];       // Transaction IDs
}

export interface MockAccount {
  address: string;
  usdcBalance: string;          // BigNumber as string
}

export interface MockEvent {
  type: string;                 // TransactionCreated, EscrowLinked, etc.
  timestamp: number;
  blockNumber: number;
  data: Record<string, any>;
}
```

**Example State File:**

```json
{
  "version": "1.0",
  "mode": "mock",
  "blockchain": {
    "currentTime": 1733990400,
    "blockNumber": 1000,
    "chainId": 84532
  },
  "transactions": {
    "0x1234abcd...": {
      "id": "0x1234abcd...",
      "requester": "0xAAA...",
      "provider": "0xBBB...",
      "amount": "1000000",
      "state": "COMMITTED",
      "createdAt": 1733990000,
      "updatedAt": 1733990100,
      "deadline": 1734076400,
      "disputeWindow": 172800,
      "escrowId": "escrow-001",
      "events": [
        {
          "type": "TransactionCreated",
          "timestamp": 1733990000,
          "blockNumber": 1000,
          "data": { "amount": "1000000" }
        },
        {
          "type": "EscrowLinked",
          "timestamp": 1733990100,
          "blockNumber": 1001,
          "data": { "escrowId": "escrow-001" }
        }
      ]
    }
  },
  "escrows": {
    "escrow-001": {
      "id": "escrow-001",
      "balance": "1000000",
      "locked": true,
      "transactions": ["0x1234abcd..."]
    }
  },
  "accounts": {
    "0xAAA...": {
      "address": "0xAAA...",
      "usdcBalance": "9000000"
    },
    "0xBBB...": {
      "address": "0xBBB...",
      "usdcBalance": "5000000"
    }
  }
}
```

---

## 4. Class Interface

```typescript
// src/runtime/MockStateManager.ts

import fs from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';

export class MockStateManager {
  private statePath: string;
  private lockPath: string;

  /**
   * @param projectRoot - Root directory for .actp/ (defaults to process.cwd())
   */
  constructor(projectRoot: string = process.cwd());

  /**
   * Load state from disk. Returns default state if file doesn't exist.
   * @throws {SyntaxError} If state file is corrupted (invalid JSON)
   */
  loadState(): MockState;

  /**
   * Save state to disk atomically (write to temp file, then rename).
   * @throws {Error} If write fails (disk full, permissions, etc.)
   */
  saveState(state: MockState): void;

  /**
   * Execute operation with file lock to prevent concurrent access.
   * The operation receives a reference to the loaded state, modifies it,
   * and the modified state is saved atomically after the operation completes.
   *
   * @param operation - Async or sync function that modifies state
   * @returns Promise resolving to operation's return value
   * @throws {Error} If lock cannot be acquired after retries
   */
  async withLock<T>(operation: (state: MockState) => T | Promise<T>): Promise<T>;

  /**
   * Reset state to default (fresh blockchain).
   */
  reset(): void;

  /**
   * Check if mock mode is initialized (state file exists).
   */
  exists(): boolean;

  /**
   * Get default/initial state.
   */
  private getDefaultState(): MockState;
}
```

---

## 5. Implementation Details

### 5.1 Constructor

```typescript
constructor(projectRoot: string = process.cwd()) {
  const actpDir = path.join(projectRoot, '.actp');
  this.statePath = path.join(actpDir, 'mock-state.json');
  this.lockPath = this.statePath; // proper-lockfile uses file itself for locking

  // Ensure .actp directory exists
  if (!fs.existsSync(actpDir)) {
    fs.mkdirSync(actpDir, { recursive: true });
  }
}
```

**Why `.actp/` directory?**
- Hidden dotfile convention (like `.git/`, `.next/`)
- Project-scoped (each project has isolated mock state)
- Git-ignorable (`.gitignore` excludes `mock-state.json`)

### 5.2 loadState()

```typescript
loadState(): MockState {
  try {
    if (!fs.existsSync(this.statePath)) {
      return this.getDefaultState();
    }

    const raw = fs.readFileSync(this.statePath, 'utf-8');
    const state = JSON.parse(raw);

    // Validate version
    if (state.version !== '1.0') {
      throw new Error(`Unsupported state version: ${state.version}`);
    }

    return state;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Mock state file corrupted: ${this.statePath}\n` +
        `Delete it manually or run: actp mock reset`
      );
    }
    throw error;
  }
}
```

**Error Handling:**
- **File doesn't exist**: Return default state (initial blockchain)
- **Invalid JSON**: Throw with helpful message suggesting `actp mock reset`
- **Unsupported version**: Throw version mismatch error

### 5.3 saveState()

```typescript
saveState(state: MockState): void {
  try {
    // Write to temp file first (atomic operation)
    const tempPath = `${this.statePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');

    // Rename (atomic on POSIX systems)
    fs.renameSync(tempPath, this.statePath);
  } catch (error) {
    throw new Error(`Failed to save mock state: ${error.message}`);
  }
}
```

**Why Atomic Write?**
- **Problem**: If process crashes during `writeFileSync`, state file is corrupted
- **Solution**: Write to temp file, then rename (rename is atomic on POSIX)
- **Result**: State file is either old version or new version, never half-written

**Performance:**
- JSON stringify: ~5ms (100 transactions)
- Write temp file: ~10ms (SSD)
- Rename: ~1ms
- **Total**: ~16ms

### 5.4 withLock()

```typescript
async withLock<T>(operation: (state: MockState) => T | Promise<T>): Promise<T> {
  let release: (() => Promise<void>) | null = null;

  try {
    // Acquire lock (blocks if another process has lock)
    release = await lockfile.lock(this.statePath, {
      retries: {
        retries: 5,
        minTimeout: 100,
        maxTimeout: 1000,
      },
      stale: 10000, // Consider lock stale after 10 seconds
    });

    // Load current state
    const state = this.loadState();

    // Execute operation (may modify state)
    const result = await operation(state);

    // Save updated state
    this.saveState(state);

    return result;
  } finally {
    // Release lock (even if operation throws)
    if (release) {
      await release();
    }
  }
}
```

**Locking Strategy:**
- **Library**: `proper-lockfile` (battle-tested, used by npm)
- **Retries**: 5 attempts over 1 second (100ms → 200ms → 400ms → 800ms → 1000ms)
- **Stale Lock**: Auto-release after 10 seconds (handles process crashes)
- **Release**: Always released in `finally` block (even if operation throws)

**Concurrency Example:**

```typescript
// Two CLI commands running simultaneously
Process A: actp tx create --amount 100
Process B: actp tx create --amount 200

Timeline:
T+0ms:   Process A acquires lock
T+5ms:   Process B attempts lock → blocked (retry 1/5)
T+85ms:  Process A releases lock
T+105ms: Process B attempts lock → success
T+190ms: Process B releases lock

Result: Both transactions created correctly, no corruption
```

### 5.5 reset()

```typescript
reset(): void {
  const defaultState = this.getDefaultState();
  this.saveState(defaultState);
}
```

**Usage**: `actp mock reset` CLI command

### 5.6 exists()

```typescript
exists(): boolean {
  return fs.existsSync(this.statePath);
}
```

**Usage**: Check if mock mode is initialized before operations

### 5.7 getDefaultState()

```typescript
private getDefaultState(): MockState {
  return {
    version: '1.0',
    mode: 'mock',
    blockchain: {
      currentTime: Math.floor(Date.now() / 1000),
      blockNumber: 1000,
      chainId: 84532, // Base Sepolia
    },
    transactions: {},
    escrows: {},
    accounts: {},
  };
}
```

**Initial State:**
- Empty blockchain (no transactions, escrows, accounts)
- Current Unix timestamp
- Starting block number: 1000 (arbitrary)
- Base Sepolia chain ID

---

## 6. Usage Examples

### 6.1 Basic Usage (SDK)

```typescript
import { MockStateManager } from './runtime/MockStateManager';

const stateManager = new MockStateManager();

// Load state
const state = stateManager.loadState();
console.log('Current time:', state.blockchain.currentTime);
console.log('Transactions:', Object.keys(state.transactions).length);

// Modify and save
state.blockchain.currentTime += 3600; // Advance 1 hour
stateManager.saveState(state);
```

### 6.2 With Lock (Safe Concurrent Access)

```typescript
const stateManager = new MockStateManager();

// Create transaction (with lock)
const txId = await stateManager.withLock(async (state) => {
  const txId = generateTxId();

  state.transactions[txId] = {
    id: txId,
    requester: '0xAAA...',
    provider: '0xBBB...',
    amount: '1000000',
    state: 'INITIATED',
    createdAt: state.blockchain.currentTime,
    updatedAt: state.blockchain.currentTime,
    deadline: state.blockchain.currentTime + 86400,
    disputeWindow: 172800,
    escrowId: null,
    events: [
      {
        type: 'TransactionCreated',
        timestamp: state.blockchain.currentTime,
        blockNumber: state.blockchain.blockNumber,
        data: { amount: '1000000' },
      },
    ],
  };

  return txId;
});

console.log('Created transaction:', txId);
```

### 6.3 CLI Integration

```typescript
// cli/src/commands/tx/create.ts

import { MockStateManager } from '@agirails/sdk/runtime';

export async function createTxCommand(options: CreateOptions) {
  const stateManager = new MockStateManager();

  const txId = await stateManager.withLock(async (state) => {
    // Create transaction logic
    const txId = generateTxId();
    state.transactions[txId] = { /* ... */ };

    // Deduct balance from requester
    const requester = state.accounts[options.requester];
    requester.usdcBalance = (
      BigInt(requester.usdcBalance) - BigInt(options.amount)
    ).toString();

    return txId;
  });

  console.log('Transaction created:', txId);
}
```

### 6.4 MockRuntime Integration

```typescript
// src/runtime/MockRuntime.ts

export class MockRuntime implements BlockchainRuntime {
  private stateManager: MockStateManager;

  constructor(projectRoot?: string) {
    this.stateManager = new MockStateManager(projectRoot);
  }

  async sendTransaction(method: string, params: any[]): Promise<TransactionReceipt> {
    return this.stateManager.withLock(async (state) => {
      // Route to appropriate handler
      switch (method) {
        case 'createTransaction':
          return this.handleCreateTransaction(state, params);
        case 'linkEscrow':
          return this.handleLinkEscrow(state, params);
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    });
  }

  async call(method: string, params: any[]): Promise<any> {
    // Read-only, no lock needed
    const state = this.stateManager.loadState();

    switch (method) {
      case 'getTransaction':
        return state.transactions[params[0]];
      default:
        throw new Error(`Unknown view method: ${method}`);
    }
  }
}
```

---

## 7. Performance Characteristics

| Operation | Time | Notes |
|-----------|------|-------|
| **loadState()** | ~10ms | JSON parse (100 transactions) |
| **saveState()** | ~20ms | JSON stringify + atomic write (SSD) |
| **withLock()** (no contention) | ~35ms | load + operation + save |
| **withLock()** (with contention) | ~135ms | Wait for lock (100ms retry) + 35ms |
| **Lock acquisition** | ~5ms | File lock creation |
| **Lock release** | ~1ms | File lock deletion |

**Scalability:**
- 100 transactions: ~10ms load, ~20ms save
- 1,000 transactions: ~50ms load, ~100ms save
- 10,000 transactions: ~500ms load, ~1000ms save

**Optimization Strategy:**
- For MVP: File-based is sufficient (< 1000 transactions typical)
- For Phase 2 (> 1000 transactions): Migrate to SQLite

---

## 8. Error Handling

### 8.1 Corrupted State File

```typescript
try {
  const state = stateManager.loadState();
} catch (error) {
  if (error.message.includes('corrupted')) {
    console.error(chalk.red('Mock state file is corrupted!'));
    console.error('Options:');
    console.error('  1. Delete manually: rm .actp/mock-state.json');
    console.error('  2. Reset to default: actp mock reset');
    process.exit(1);
  }
}
```

### 8.2 Lock Timeout

```typescript
try {
  await stateManager.withLock(async (state) => { /* ... */ });
} catch (error) {
  if (error.code === 'ELOCKED') {
    console.error(chalk.yellow('Could not acquire lock on mock state.'));
    console.error('Another ACTP process may be running.');
    console.error('Please wait a moment and try again.');
    process.exit(1);
  }
}
```

### 8.3 Disk Full

```typescript
try {
  stateManager.saveState(state);
} catch (error) {
  if (error.code === 'ENOSPC') {
    console.error(chalk.red('Disk full! Cannot save mock state.'));
    console.error('Free up disk space and try again.');
    process.exit(1);
  }
}
```

---

## 9. Testing Strategy

### 9.1 Unit Tests

```typescript
// test/MockStateManager.test.ts

import { MockStateManager } from '../src/runtime/MockStateManager';
import fs from 'fs';
import path from 'path';

describe('MockStateManager', () => {
  let stateManager: MockStateManager;
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(__dirname, '.test-actp');
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    stateManager = new MockStateManager(testDir);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  test('loadState() returns default state if file does not exist', () => {
    const state = stateManager.loadState();
    expect(state.version).toBe('1.0');
    expect(state.mode).toBe('mock');
    expect(Object.keys(state.transactions)).toHaveLength(0);
  });

  test('saveState() creates file atomically', () => {
    const state = stateManager.loadState();
    state.blockchain.currentTime += 1000;

    stateManager.saveState(state);

    const loaded = stateManager.loadState();
    expect(loaded.blockchain.currentTime).toBe(state.blockchain.currentTime);
  });

  test('withLock() prevents concurrent access', async () => {
    const results: number[] = [];

    // Two concurrent operations
    await Promise.all([
      stateManager.withLock(async (state) => {
        await new Promise(resolve => setTimeout(resolve, 50));
        state.blockchain.blockNumber += 1;
        results.push(1);
      }),
      stateManager.withLock(async (state) => {
        state.blockchain.blockNumber += 1;
        results.push(2);
      }),
    ]);

    // Both operations completed
    expect(results).toEqual([1, 2]);

    // Block number incremented twice
    const state = stateManager.loadState();
    expect(state.blockchain.blockNumber).toBe(1002); // 1000 + 1 + 1
  });

  test('loadState() throws on corrupted JSON', () => {
    const statePath = path.join(testDir, '.actp', 'mock-state.json');
    fs.writeFileSync(statePath, '{ invalid json }', 'utf-8');

    expect(() => stateManager.loadState()).toThrow('corrupted');
  });

  test('reset() restores default state', () => {
    const state = stateManager.loadState();
    state.transactions['0x123'] = { /* ... */ } as any;
    stateManager.saveState(state);

    stateManager.reset();

    const resetState = stateManager.loadState();
    expect(Object.keys(resetState.transactions)).toHaveLength(0);
  });
});
```

### 9.2 Integration Tests

```typescript
// test/integration/cli-state-sharing.test.ts

import { execSync } from 'child_process';

describe('CLI State Sharing', () => {
  beforeEach(() => {
    execSync('actp mock reset');
  });

  test('CLI commands share state across processes', () => {
    // Create transaction in process 1
    const output1 = execSync('actp tx create --to 0xABC --amount 100 --json', {
      encoding: 'utf-8',
    });
    const result1 = JSON.parse(output1);

    // List transactions in process 2
    const output2 = execSync('actp tx list --json', { encoding: 'utf-8' });
    const result2 = JSON.parse(output2);

    // Transaction visible in second process
    expect(result2.transactions).toHaveLength(1);
    expect(result2.transactions[0].id).toBe(result1.txId);
  });
});
```

---

## 10. Security Considerations

### 10.1 File Permissions

**Default Permissions**: `0644` (owner read/write, group/others read-only)

```typescript
// Ensure .actp directory is not world-writable
fs.mkdirSync(actpDir, { recursive: true, mode: 0o755 });
fs.writeFileSync(statePath, JSON.stringify(state), {
  encoding: 'utf-8',
  mode: 0o644,
});
```

### 10.2 State File Size Limits

**Limit**: 10 MB (prevents disk exhaustion)

```typescript
loadState(): MockState {
  const stats = fs.statSync(this.statePath);
  if (stats.size > 10 * 1024 * 1024) { // 10 MB
    throw new Error('Mock state file exceeds 10 MB. Run: actp mock compact');
  }
  // ... rest of load logic
}
```

### 10.3 Injection Prevention

**Validate State Schema** (prevent malicious JSON):

```typescript
import Ajv from 'ajv';

const ajv = new Ajv();
const validateState = ajv.compile(stateSchema);

loadState(): MockState {
  const state = JSON.parse(raw);

  if (!validateState(state)) {
    throw new Error('State schema validation failed');
  }

  return state;
}
```

---

## 11. Future Enhancements

### 11.1 State Compression (Phase 2)

```typescript
import zlib from 'zlib';

saveState(state: MockState): void {
  const json = JSON.stringify(state);
  const compressed = zlib.gzipSync(json);
  fs.writeFileSync(this.statePath, compressed);
}

loadState(): MockState {
  const compressed = fs.readFileSync(this.statePath);
  const json = zlib.gunzipSync(compressed).toString('utf-8');
  return JSON.parse(json);
}
```

**Benefit**: ~70% size reduction for large states (> 1000 transactions)

### 11.2 SQLite Backend (Phase 2)

```typescript
class MockStateManager {
  constructor(backend: 'file' | 'sqlite' = 'file') {
    if (backend === 'sqlite') {
      this.db = new Database('.actp/mock-state.db');
    }
  }
}
```

**Benefits**:
- Faster queries (indexed lookups)
- Supports > 10,000 transactions
- ACID transactions built-in

### 11.3 State Snapshots (Phase 3)

```typescript
class MockStateManager {
  snapshot(): string {
    const snapshotId = generateId();
    const snapshotPath = path.join('.actp', 'snapshots', `${snapshotId}.json`);
    fs.copyFileSync(this.statePath, snapshotPath);
    return snapshotId;
  }

  restore(snapshotId: string): void {
    const snapshotPath = path.join('.actp', 'snapshots', `${snapshotId}.json`);
    fs.copyFileSync(snapshotPath, this.statePath);
  }
}
```

**Usage**: `actp mock snapshot`, `actp mock restore <id>`

---

## 12. Dependencies

```json
{
  "dependencies": {
    "proper-lockfile": "^4.1.2"
  }
}
```

**Why `proper-lockfile`?**
- Battle-tested (used by npm, yarn)
- Cross-platform (Windows, macOS, Linux)
- Stale lock detection
- Retry logic built-in

---

## 13. Implementation Checklist

- [ ] Create `src/runtime/MockStateManager.ts`
- [ ] Add `proper-lockfile` dependency to package.json
- [ ] Implement `loadState()` with error handling
- [ ] Implement `saveState()` with atomic write
- [ ] Implement `withLock()` with retry logic
- [ ] Implement `reset()` method
- [ ] Add state schema validation (optional for MVP)
- [ ] Write unit tests (load, save, lock, concurrent access)
- [ ] Write integration tests (CLI state sharing)
- [ ] Add `.gitignore` entry for `mock-state.json`
- [ ] Document in Mock Mode Specification
- [ ] Create `actp mock reset` CLI command

---

**Version:** 1.0
**Date:** December 12, 2025
**Status:** Final
