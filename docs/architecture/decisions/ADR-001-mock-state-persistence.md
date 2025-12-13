# ADR-001: Mock State Persistence Strategy

## Status
**Accepted** - December 12, 2025

## Context

The AGIRAILS SDK implements a Mock Mode that simulates blockchain behavior for local development and testing. This mock runtime must maintain consistent state across multiple interactions, but faces a fundamental architectural challenge:

**The Problem**: CLI commands execute as separate Node.js processes, each creating a new SDK instance. Without persistent state storage, each CLI invocation would start with a clean slate, making it impossible to:

- Create a transaction in one CLI call (`actp tx create`)
- Query it in another CLI call (`actp tx show <id>`)
- Simulate time progression (`actp mock time +1h`) that affects all transactions
- Share mock state between CLI, SDK programmatic usage, and Dashboard

**Requirements**:

1. **Cross-Process State Sharing**: CLI, SDK library usage, and Dashboard must see identical mock state
2. **Time Manipulation**: Developer must be able to advance `block.timestamp` and see effects on transaction deadlines, dispute windows
3. **Atomicity**: State updates must be atomic to prevent corruption from concurrent operations
4. **Human-Readable**: Developers should be able to inspect and manually edit state for debugging
5. **Zero Dependencies**: Should not require external services (Redis, databases) for basic local development
6. **Performance**: State load/save should be fast enough for CLI responsiveness (<100ms)

**Scale Assumptions** (MVP):
- Single developer, single machine
- ~10-100 mock transactions in typical workflow
- Concurrent access rare (developer runs one CLI command at a time)
- State file size: <1 MB

## Decision

**We will use file-based JSON persistence** with the following architecture:

### State File Location
```
.actp/
├── mock-state.json       # Persistent state
├── mock-state.lock       # Lock file for atomic operations
└── config.json           # SDK configuration (mode, network, etc.)
```

**Why `.actp/` directory**:
- Convention: Hidden dotfiles for tool state (e.g., `.git/`, `.next/`)
- Project-scoped: Each project has its own mock state
- Git-ignorable: Added to `.gitignore` by `actp init`

### State Schema

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
    "0x1234...": {
      "id": "0x1234...",
      "requester": "0xAAA...",
      "provider": "0xBBB...",
      "amount": "1000000",
      "state": "COMMITTED",
      "createdAt": 1733990000,
      "deadline": 1734076400,
      "disputeWindow": 172800,
      "escrowId": "escrow-001",
      "events": [
        {
          "type": "TransactionCreated",
          "timestamp": 1733990000,
          "blockNumber": 1000
        }
      ]
    }
  },
  "escrows": {
    "escrow-001": {
      "id": "escrow-001",
      "balance": "1000000",
      "locked": true,
      "transactions": ["0x1234..."]
    }
  },
  "accounts": {
    "0xAAA...": {
      "address": "0xAAA...",
      "usdcBalance": "10000000000"
    }
  }
}
```

### Implementation: MockStateManager Class

```typescript
// src/runtime/MockStateManager.ts

import fs from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';

export interface MockState {
  version: string;
  mode: 'mock';
  blockchain: {
    currentTime: number;
    blockNumber: number;
    chainId: number;
  };
  transactions: Record<string, any>;
  escrows: Record<string, any>;
  accounts: Record<string, any>;
}

export class MockStateManager {
  private statePath: string;
  private lockPath: string;

  constructor(projectRoot: string = process.cwd()) {
    const actpDir = path.join(projectRoot, '.actp');
    this.statePath = path.join(actpDir, 'mock-state.json');
    this.lockPath = this.statePath; // proper-lockfile uses file itself for locking

    // Ensure .actp directory exists
    if (!fs.existsSync(actpDir)) {
      fs.mkdirSync(actpDir, { recursive: true });
    }
  }

  /**
   * Load state from disk. Returns default state if file doesn't exist.
   */
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

  /**
   * Save state to disk atomically.
   */
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

  /**
   * Execute operation with file lock to prevent concurrent access.
   */
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

      // Execute operation
      const result = await operation(state);

      // Save updated state
      this.saveState(state);

      return result;
    } finally {
      // Release lock
      if (release) {
        await release();
      }
    }
  }

  /**
   * Reset state to default (useful for `actp mock reset`)
   */
  reset(): void {
    const defaultState = this.getDefaultState();
    this.saveState(defaultState);
  }

  /**
   * Check if mock mode is initialized
   */
  exists(): boolean {
    return fs.existsSync(this.statePath);
  }

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
}
```

### Concurrency Strategy

**For MVP** (single developer):
- File locking with `proper-lockfile` library (battle-tested, used by npm)
- Retry mechanism: 5 retries over 1 second if lock held
- Stale lock detection: Auto-release after 10 seconds (handles process crashes)

**Performance**:
- File lock acquisition: ~5ms (no contention)
- JSON parse/stringify: ~10ms for 100 transactions
- Disk I/O: ~20ms (SSD)
- **Total**: ~35ms per operation (well below 100ms target)

**Limitations** (acceptable for MVP):
- Not safe for simultaneous CLI calls (rare in practice)
- No distributed locking (not needed - single machine)
- No transaction log (undo/redo not required)

## Consequences

### Positive

1. **Zero Dependencies**: No Redis, PostgreSQL, or background daemons required
2. **Human-Readable**: Developers can `cat .actp/mock-state.json` to debug
3. **Git-Friendly**: Each project has isolated state, can commit state for reproducible tests
4. **Fast**: <50ms overhead for typical operations
5. **Debuggable**: State file can be manually edited or scripted
6. **Cross-Process**: CLI, SDK, Dashboard all read/write same file

### Negative

1. **Not Database**: No indexing, complex queries, or relations
   - Mitigation: Mock mode is for <100 transactions, linear search is fine
2. **File Locking Limitations**: Concurrent operations may fail with timeout
   - Mitigation: Retry mechanism + rare concurrency in single-dev workflow
3. **No Versioning**: Overwriting state loses history
   - Mitigation: `actp mock snapshot` command can backup state (future)
4. **Memory Overhead**: Full state loaded on every operation
   - Mitigation: <1 MB state = negligible

### Migration Path

When requirements exceed file-based storage (e.g., team usage, >1000 transactions):

**Phase 2: SQLite Backend** (Embedded database)
```typescript
class MockStateManager {
  constructor(backend: 'file' | 'sqlite' = 'file') {
    if (backend === 'sqlite') {
      this.db = new Database('.actp/mock-state.db');
    }
  }
}
```

**Phase 3: Client-Server Mode** (Shared mock network for team)
```bash
actp mock server start --port 3000  # Central mock server
actp tx create --mock-server http://localhost:3000
```

## Alternatives Considered

### Alternative A: Pure In-Memory (No Persistence)

**Rejected** because:
- CLI commands are separate processes - no shared memory
- Each `actp` invocation would start with empty state
- Impossible to simulate stateful workflows

### Alternative B: Redis

**Pros**:
- Fast, battle-tested
- Built-in locking, pub/sub for events
- Handles concurrency well

**Cons**:
- Requires Redis installation (barrier to entry)
- Overkill for single-developer MVP
- Not human-readable (binary protocol)
- Can't easily version control state

**Decision**: Rejected for MVP, reconsidered for Phase 3 (team mode)

### Alternative C: SQLite

**Pros**:
- Embedded database, no server required
- SQL queries for complex filtering
- ACID transactions
- Better than JSON for >1000 records

**Cons**:
- Not human-readable (binary format)
- Requires SQL schema migrations
- Overkill for MVP (<100 transactions)

**Decision**: Rejected for MVP, **planned for Phase 2**

### Alternative D: PostgreSQL

**Rejected**: Massive overkill, requires server, too heavy for local dev tool

## References

- [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) - File locking library
- [Atomic File Writes](https://rcrowley.org/2010/01/06/things-unix-can-do-atomically.html) - Using rename() for atomicity
- [Git Internal Storage](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects) - Inspiration for file-based object storage

## Implementation Checklist

- [ ] Create `MockStateManager` class (src/runtime/MockStateManager.ts)
- [ ] Add `proper-lockfile` dependency to package.json
- [ ] Implement `withLock()` method with retry logic
- [ ] Add schema validation (Zod or JSON Schema)
- [ ] Write unit tests (lock acquisition, concurrent access, corrupted state)
- [ ] Add `actp mock reset` CLI command
- [ ] Update `.gitignore` to exclude `.actp/mock-state.json`
- [ ] Document state schema in Mock Mode Specification
