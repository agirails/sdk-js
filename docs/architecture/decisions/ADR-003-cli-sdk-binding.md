# ADR-003: CLI-SDK Binding Strategy

## Status
**Accepted** - December 12, 2025

## Context

The AGIRAILS CLI (`actp` command) must interact with the same mock state and protocol logic as the TypeScript SDK. This creates an architectural challenge around process boundaries and state sharing.

### The Problem

```bash
# Developer workflow:
$ actp mock start
Mock mode initialized

$ actp tx create --to 0xProvider --amount 100
Transaction created: 0xabc123

$ actp tx show 0xabc123
State: INITIATED
Amount: 100.00 USDC
...
```

**Question**: How do these three separate process invocations (`actp mock start`, `actp tx create`, `actp tx show`) share state?

**Options**:
1. **Daemon Process**: Long-running background server that CLI talks to via IPC/HTTP
2. **File-Based State**: Each CLI invocation loads SDK, reads state from disk, executes, saves state
3. **Embedded Runtime**: CLI embeds Node.js runtime with persistent state (like Deno/Bun)

### Requirements

1. **State Consistency**: All CLI commands must see identical mock state
2. **SDK Reusability**: CLI should use SDK as library, not reimplement protocol logic
3. **Developer Experience**: No complex setup (no "start server first" requirement)
4. **Performance**: Commands should feel instant (<200ms for simple operations)
5. **Error Handling**: SDK errors should be caught and formatted for CLI output
6. **Cross-Platform**: Work on macOS, Linux, Windows

### Constraints

- **MVP Scope**: Single developer, local machine only
- **No Network Dependency**: CLI should work offline (except testnet/mainnet modes)
- **Simple Installation**: `npm install -g @agirails/cli` should be sufficient
- **Minimal Memory**: Don't keep unnecessary processes running

## Decision

**We will use the File-Based State approach** with the following architecture:

```
┌──────────────────────────────────────────────┐
│  CLI Command (separate process)              │
│  $ actp tx create --to 0xABC --amount 100    │
└────────────┬─────────────────────────────────┘
             │
             │ 1. Import SDK
             ▼
┌────────────────────────────────────────────────┐
│  SDK Instance (in CLI process)                 │
│  const client = await ACTPClient.create({...}) │
└────────────┬───────────────────────────────────┘
             │
             │ 2. Read state
             ▼
┌────────────────────────────────────────────────┐
│  MockStateManager                              │
│  .actp/mock-state.json (file on disk)         │
└────────────┬───────────────────────────────────┘
             │
             │ 3. Execute operation
             ▼
┌────────────────────────────────────────────────┐
│  MockRuntime                                   │
│  Simulate blockchain behavior                  │
└────────────┬───────────────────────────────────┘
             │
             │ 4. Save state
             ▼
┌────────────────────────────────────────────────┐
│  MockStateManager                              │
│  .actp/mock-state.json (updated)               │
└────────────────────────────────────────────────┘
```

### Architecture

**CLI Package Structure**:
```
@agirails/cli/
├── src/
│   ├── commands/
│   │   ├── init.ts          # actp init
│   │   ├── tx/
│   │   │   ├── create.ts    # actp tx create
│   │   │   ├── show.ts      # actp tx show
│   │   │   └── list.ts      # actp tx list
│   │   ├── mock/
│   │   │   ├── start.ts     # actp mock start
│   │   │   └── time.ts      # actp mock time +1h
│   │   └── wallet/
│   │       └── status.ts    # actp wallet status
│   ├── utils/
│   │   ├── sdk-client.ts    # SDK initialization helper
│   │   ├── formatters.ts    # Output formatting
│   │   └── errors.ts        # Error handling
│   └── index.ts             # CLI entry point
├── package.json
└── README.md
```

**Dependencies**:
```json
{
  "name": "@agirails/cli",
  "version": "1.0.0",
  "dependencies": {
    "@agirails/sdk": "^1.0.0",    // Core SDK
    "commander": "^11.0.0",        // CLI framework
    "chalk": "^5.0.0",             // Terminal colors
    "ora": "^6.0.0",               // Spinners
    "enquirer": "^2.4.0"           // Interactive prompts
  },
  "bin": {
    "actp": "./dist/index.js"
  }
}
```

### Implementation

#### 1. SDK Client Factory (Shared Initialization Logic)

```typescript
// cli/src/utils/sdk-client.ts

import { ACTPClient } from '@agirails/sdk';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

export interface CLIConfig {
  mode: 'mock' | 'testnet' | 'mainnet';
  network?: 'base-sepolia' | 'base-mainnet';
  privateKey?: string;
  rpcUrl?: string;
}

/**
 * Load CLI configuration from .actp/config.json
 */
export function loadConfig(): CLIConfig {
  const configPath = join(process.cwd(), '.actp', 'config.json');

  if (!existsSync(configPath)) {
    throw new Error(
      `ACTP not initialized. Run: ${chalk.blue('actp init')}`
    );
  }

  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Create SDK client from CLI config
 */
export async function createSDKClient(): Promise<ACTPClient> {
  const config = loadConfig();

  // Validate mode-specific requirements
  if (config.mode === 'testnet' || config.mode === 'mainnet') {
    if (!config.privateKey) {
      throw new Error('Private key required for testnet/mainnet mode');
    }
    if (!config.rpcUrl) {
      throw new Error('RPC URL required for testnet/mainnet mode');
    }
  }

  // Initialize SDK client
  const client = await ACTPClient.create({
    mode: config.mode,
    network: config.network,
    privateKey: config.privateKey,
    rpcUrl: config.rpcUrl,
  });

  return client;
}

/**
 * Format SDK errors for CLI output
 */
export function formatSDKError(error: any): string {
  // ValidationError from adapters
  if (error.name === 'ValidationError') {
    return chalk.red(`Validation Error: ${error.message}`);
  }

  // Protocol errors from kernel
  if (error.code === 'PROTOCOL_ERROR') {
    return chalk.red(`Protocol Error: ${error.message}`);
  }

  // Network errors
  if (error.code === 'NETWORK_ERROR') {
    return chalk.red(`Network Error: ${error.message}\nCheck your RPC connection.`);
  }

  // Generic error
  return chalk.red(`Error: ${error.message}`);
}
```

#### 2. Example Command Implementation

```typescript
// cli/src/commands/tx/create.ts

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createSDKClient, formatSDKError } from '../../utils/sdk-client';

export function createTxCommand(): Command {
  return new Command('create')
    .description('Create a new transaction')
    .requiredOption('--to <address>', 'Provider address')
    .requiredOption('--amount <amount>', 'Amount in USDC')
    .option('--deadline <time>', 'Deadline (e.g., "+24h")', '+24h')
    .option('--dispute-window <seconds>', 'Dispute window in seconds', '172800')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const spinner = ora('Creating transaction...').start();

      try {
        // Initialize SDK client (loads state from disk)
        const client = await createSDKClient();

        // Call SDK (which reads/writes to .actp/mock-state.json)
        const result = await client.beginner.pay({
          to: options.to,
          amount: options.amount,
          deadline: options.deadline,
          disputeWindow: parseInt(options.disputeWindow),
        });

        spinner.succeed('Transaction created');

        // Output
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.green('\n✓ Transaction Created\n'));
          console.log(`${chalk.bold('Transaction ID:')} ${result.txId}`);
          console.log(`${chalk.bold('Provider:')} ${result.provider}`);
          console.log(`${chalk.bold('Amount:')} ${result.amount}`);
          console.log(`${chalk.bold('Deadline:')} ${result.deadline}`);
          console.log(`${chalk.bold('State:')} ${result.state}`);
        }

        process.exit(0);
      } catch (error) {
        spinner.fail('Failed to create transaction');
        console.error(formatSDKError(error));
        process.exit(1);
      }
    });
}
```

#### 3. State Lifecycle in CLI

```
Process Start (actp tx create)
  │
  ├─> Load config from .actp/config.json
  │
  ├─> Initialize SDK client
  │   └─> ACTPClient.create({ mode: 'mock' })
  │       └─> RuntimeFactory.create('mock')
  │           └─> new MockRuntime(new MockStateManager())
  │
  ├─> MockStateManager.loadState()
  │   └─> Read .actp/mock-state.json from disk
  │
  ├─> Execute SDK operation
  │   └─> client.beginner.pay(...)
  │       └─> BeginnerAdapter.pay(...)
  │           └─> Kernel.createTransaction(...)
  │               └─> MockRuntime.sendTransaction(...)
  │                   └─> Modify in-memory state
  │
  ├─> MockStateManager.saveState()
  │   └─> Write .actp/mock-state.json to disk (atomic rename)
  │
  └─> Process Exit
```

**Performance Characteristics**:
- SDK initialization: ~50ms (lazy-load contracts)
- State load (JSON parse): ~10ms (100 transactions)
- Operation execution: ~5ms (in-memory)
- State save (atomic write): ~20ms (SSD)
- **Total**: ~85ms (well under 200ms target)

#### 4. Configuration File

```json
// .actp/config.json (created by `actp init`)
{
  "version": "1.0",
  "mode": "mock",
  "network": "base-sepolia",
  "privateKey": "0x...",  // Only for testnet/mainnet
  "rpcUrl": "https://...", // Only for testnet/mainnet
  "defaultDeadline": "+24h",
  "defaultDisputeWindow": 172800
}
```

## Consequences

### Positive

1. **Zero Setup**: No daemon to start, no ports to configure
2. **SDK Reuse**: CLI is thin wrapper (100-200 LOC per command)
3. **Consistent Logic**: All protocol logic in SDK, CLI just formats output
4. **Offline-First**: Mock mode works without network
5. **Simple Debugging**: Can inspect `.actp/mock-state.json` directly
6. **Fast Enough**: <100ms for most operations (feels instant)
7. **Process Isolation**: Each command runs independently, no shared memory bugs

### Negative

1. **Startup Overhead**: ~50ms per CLI invocation (SDK + state load)
   - Mitigation: Acceptable for developer tool, not user-facing
2. **No Real-Time Updates**: Dashboard won't see CLI changes until refresh
   - Mitigation: File watcher in Dashboard (future enhancement)
3. **Concurrent Access Риски**: Two simultaneous CLI calls may conflict
   - Mitigation: File locking (proper-lockfile) + retry logic
4. **Memory Duplication**: Each CLI call loads full SDK into memory
   - Mitigation: <50 MB per process, cleaned up on exit

### Trade-offs vs Daemon Architecture

| Aspect | File-Based (Our Choice) | Daemon |
|--------|-------------------------|--------|
| **Setup** | Zero (just install CLI) | Must start server first |
| **Performance** | ~85ms per command | ~10ms per command (IPC) |
| **State Consistency** | File locking required | Built-in (single process) |
| **Memory** | Per-command overhead | Persistent ~100 MB |
| **Developer UX** | Simple (no background process) | Complex (manage daemon lifecycle) |
| **Debugging** | Inspect state file | Need IPC/HTTP client |
| **Failure Mode** | Process crash = no cleanup | Daemon crash = all operations fail |

**Decision Rationale**: For MVP (single developer), simplicity > performance. 85ms is acceptable.

### Migration Path

**Phase 2: Optional Daemon Mode** (if team adoption requires performance)

```bash
# Start daemon (optional, for power users)
actp server start --port 3000

# CLI auto-detects daemon and uses IPC
actp tx create --to 0xABC --amount 100
# (Connects to daemon if running, falls back to file-based)
```

**Implementation**:
```typescript
// cli/src/utils/sdk-client.ts (updated)

export async function createSDKClient(): Promise<ACTPClient> {
  // Check for daemon
  const daemonUrl = process.env.ACTP_DAEMON_URL || 'http://localhost:3000';
  if (await isDaemonRunning(daemonUrl)) {
    return createRemoteClient(daemonUrl); // IPC-based
  }

  // Fall back to file-based
  return createLocalClient();
}
```

## Alternatives Considered

### Alternative A: Long-Running Daemon Process

**Architecture**:
```bash
# Start daemon (required first step)
actp server start --daemon

# CLI communicates via HTTP/IPC
actp tx create --to 0xABC --amount 100
  └─> HTTP POST localhost:3000/tx/create
```

**Pros**:
- Faster commands (~10ms vs ~85ms)
- Single SDK instance (less memory)
- Real-time state updates (Dashboard can subscribe via WebSocket)

**Cons**:
- **Complex setup**: Must start daemon before using CLI
- **Port management**: Conflicts, firewall issues
- **Process management**: Daemon crashes, restart logic
- **Cross-platform**: Windows service management different from Unix

**Decision**: Rejected for MVP. Too much complexity for marginal performance gain.

### Alternative B: Embedded Runtime (Deno/Bun-style)

**Architecture**:
- CLI bundles V8 isolates
- Each command runs in persistent isolate with shared memory
- State lives in isolate heap, not disk

**Pros**:
- Extremely fast (no disk I/O)
- Native binary (no Node.js required)

**Cons**:
- Requires Deno/Bun runtime (different toolchain)
- Not compatible with existing npm ecosystem
- Large binary size (~50 MB)
- Isolate state management is complex

**Decision**: Rejected. Too bleeding-edge, not worth rewrite.

### Alternative C: CLI Calls SDK via Child Process

```typescript
// CLI spawns SDK in separate Node process
const { stdout } = await exec('node sdk-wrapper.js createTransaction ...');
```

**Pros**:
- Process isolation
- SDK errors don't crash CLI

**Cons**:
- Huge overhead (~200ms+ per call)
- Complex argument passing (serialization)
- Error handling harder

**Decision**: Rejected. Worse performance than file-based, no benefits.

## Implementation Checklist

- [ ] Create `@agirails/cli` package (cli/)
- [ ] Add `@agirails/sdk` as dependency
- [ ] Implement `sdk-client.ts` utility (loadConfig, createSDKClient)
- [ ] Implement `formatters.ts` for output (table, JSON, colors)
- [ ] Implement `errors.ts` for error mapping
- [ ] Create commands: init, tx/create, tx/show, tx/list
- [ ] Add spinner/progress indicators (ora)
- [ ] Add interactive prompts for init (enquirer)
- [ ] Write integration tests (create CLI → verify state file)
- [ ] Add `--json` flag to all commands (for scripting)
- [ ] Document CLI → SDK binding in architecture docs
- [ ] Performance benchmark (measure end-to-end latency)

## References

- [Commander.js](https://github.com/tj/commander.js) - CLI framework
- [Chalk](https://github.com/chalk/chalk) - Terminal styling
- [Ora](https://github.com/sindresorhus/ora) - Spinners
- [Enquirer](https://github.com/enquirer/enquirer) - Interactive prompts
- [Git CLI Architecture](https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain) - File-based state inspiration
- [Vercel CLI](https://github.com/vercel/vercel/tree/main/packages/cli) - SDK-as-library pattern

## Performance Benchmarks (Expected)

```bash
# Mock mode (file-based state)
actp tx create --to 0xABC --amount 100
Time: ~85ms

actp tx show 0xabc123
Time: ~70ms (no state write)

actp tx list
Time: ~60ms (read-only)

# Testnet mode (real RPC calls)
actp tx create --to 0xABC --amount 100
Time: ~2-5 seconds (blockchain confirmation)
```

**Optimization Opportunities** (if needed):
1. Lazy-load SDK modules (only import what's needed)
2. Cache parsed state in memory (for multi-command scripts)
3. Parallel state reads (if multiple queries)
4. Compress state file (gzip for >1000 transactions)
