# ADR-004: Mock Blockchain Emulation Scope

## Status
**Accepted** - December 12, 2025

## Context

The AGIRAILS SDK Mock Mode must simulate blockchain behavior for local development. However, fully emulating an EVM blockchain is extremely complex. We must define the **minimum viable emulation** that enables productive development without reimplementing Ethereum.

### The Challenge

A real blockchain (Base L2) provides:

**State Management**:
- Account balances (ETH, USDC, etc.)
- Smart contract storage
- Transaction nonces
- Block numbers, timestamps

**Transaction Processing**:
- Gas estimation
- Gas price markets (base fee, priority fee)
- Transaction ordering (mempool)
- Block confirmation
- Transaction receipts

**Event Emission**:
- Contract event logs
- Block reorganizations
- Pending vs confirmed states

**Network Behavior**:
- Block time (~2 seconds on Base)
- Network latency
- RPC rate limits
- Node sync status

**Security**:
- Signature verification
- Access control
- Reentrancy protection

**Question**: Which of these must we emulate for productive SDK development?

### Requirements

1. **Transaction Lifecycle Testing**: Developers must be able to test full ACTP flow (create → accept → complete → settle)
2. **Time-Based Testing**: Advance `block.timestamp` to test deadlines, dispute windows
3. **State Inspection**: Query transaction state, balances, events
4. **Error Scenarios**: Simulate failures (insufficient balance, invalid signature)
5. **Fast Iteration**: No blockchain delays (instant "confirmations")
6. **Predictable**: Deterministic behavior (no random gas prices, reorgs)

### Out of Scope (MVP)

- **Gas Simulation**: No gas estimation, no gas limits
- **Mempool Behavior**: Instant transaction ordering
- **Concurrency**: Single-threaded execution (no block race conditions)
- **Network Latency**: No simulated network delays
- **Reorgs**: No block reorganizations
- **Multi-Sig/Complex Crypto**: Minimal signature validation

## Decision

**We will implement a Simplified State Machine Mock** that emulates only the features required for ACTP protocol testing:

```
┌─────────────────────────────────────────────────┐
│  MockRuntime                                    │
│                                                 │
│  ✅ IMPLEMENTED:                                │
│  - Transaction state transitions                │
│  - Event emission (logs)                        │
│  - Time manipulation (block.timestamp)          │
│  - Balance tracking (USDC only)                 │
│  - Basic signature validation (address check)   │
│  - Transaction receipts                         │
│                                                 │
│  ❌ NOT IMPLEMENTED (use Foundry/Hardhat):      │
│  - Gas estimation/limits                        │
│  - EVM opcode execution                         │
│  - Block mining simulation                      │
│  - Mempool/pending transactions                 │
│  - Reorgs                                       │
└─────────────────────────────────────────────────┘
```

## Architecture

### 1. MockRuntime Interface

```typescript
// src/runtime/MockRuntime.ts

import { BigNumber } from 'ethers';
import { MockStateManager, MockState } from './MockStateManager';
import { TransactionReceipt, Log } from '../types';

export interface BlockchainRuntime {
  /** Send transaction (state-changing operation) */
  sendTransaction(method: string, params: any[]): Promise<TransactionReceipt>;

  /** Call contract (read-only operation) */
  call(method: string, params: any[]): Promise<any>;

  /** Get current block timestamp */
  getCurrentTime(): number;

  /** Get current block number */
  getCurrentBlock(): number;

  /** Query past events */
  queryEvents(eventName: string, filter?: any): Promise<Log[]>;
}

export class MockRuntime implements BlockchainRuntime {
  private stateManager: MockStateManager;

  constructor(projectRoot?: string) {
    this.stateManager = new MockStateManager(projectRoot);
  }

  /**
   * Send transaction (state-changing)
   * Examples: createTransaction, acceptTransaction, releaseEscrow
   */
  async sendTransaction(method: string, params: any[]): Promise<TransactionReceipt> {
    return this.stateManager.withLock(async (state) => {
      // Route to appropriate handler
      switch (method) {
        case 'createTransaction':
          return this.handleCreateTransaction(state, params);
        case 'acceptTransaction':
          return this.handleAcceptTransaction(state, params);
        case 'transitionState':
          return this.handleTransitionState(state, params);
        case 'linkEscrow':
          return this.handleLinkEscrow(state, params);
        case 'releaseEscrow':
          return this.handleReleaseEscrow(state, params);
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    });
  }

  /**
   * Call contract (read-only)
   * Examples: getTransaction, getBalance, paused
   */
  async call(method: string, params: any[]): Promise<any> {
    const state = this.stateManager.loadState();

    switch (method) {
      case 'getTransaction':
        return this.getTransaction(state, params[0]);
      case 'getBalance':
        return this.getBalance(state, params[0], params[1]);
      case 'paused':
        return false; // Mock never paused
      default:
        throw new Error(`Unknown view method: ${method}`);
    }
  }

  /**
   * Get current block timestamp (can be manipulated)
   */
  getCurrentTime(): number {
    const state = this.stateManager.loadState();
    return state.blockchain.currentTime;
  }

  /**
   * Get current block number
   */
  getCurrentBlock(): number {
    const state = this.stateManager.loadState();
    return state.blockchain.blockNumber;
  }

  /**
   * Query past events
   */
  async queryEvents(eventName: string, filter?: any): Promise<Log[]> {
    const state = this.stateManager.loadState();
    const logs: Log[] = [];

    // Collect events from all transactions
    for (const tx of Object.values(state.transactions)) {
      for (const event of tx.events || []) {
        if (event.type === eventName) {
          // Apply filter (if provided)
          if (!filter || this.matchesFilter(event, filter)) {
            logs.push({
              address: '0xMockKernel', // Mock contract address
              topics: [eventName, tx.id],
              data: JSON.stringify(event),
              blockNumber: event.blockNumber,
              transactionHash: tx.id,
            });
          }
        }
      }
    }

    return logs;
  }

  /**
   * Advance time (for testing deadlines/dispute windows)
   */
  async advanceTime(seconds: number): Promise<void> {
    await this.stateManager.withLock(async (state) => {
      state.blockchain.currentTime += seconds;
      state.blockchain.blockNumber += Math.floor(seconds / 2); // ~2 sec block time
      return null;
    });
  }

  /**
   * Advance to specific timestamp
   */
  async setTime(timestamp: number): Promise<void> {
    await this.stateManager.withLock(async (state) => {
      if (timestamp < state.blockchain.currentTime) {
        throw new Error('Cannot move time backwards');
      }
      state.blockchain.currentTime = timestamp;
      return null;
    });
  }

  // --- Private Handlers ---

  private handleCreateTransaction(state: MockState, params: any[]): TransactionReceipt {
    const [provider, requester, amount, deadline, disputeWindow] = params;

    // Generate transaction ID (hash of inputs)
    const txId = this.generateTxId(provider, requester, amount);

    // Validate
    if (state.transactions[txId]) {
      throw new Error(`Transaction ${txId} already exists`);
    }

    if (deadline <= state.blockchain.currentTime) {
      throw new Error('Deadline must be in the future');
    }

    // Check requester has sufficient balance
    const requesterBalance = this.getAccountBalance(state, requester);
    if (requesterBalance.lt(amount)) {
      throw new Error(`Insufficient balance: ${requesterBalance.toString()} < ${amount.toString()}`);
    }

    // Create transaction
    const tx = {
      id: txId,
      provider,
      requester,
      amount: amount.toString(),
      state: 'INITIATED',
      createdAt: state.blockchain.currentTime,
      deadline,
      disputeWindow,
      escrowId: null,
      events: [
        {
          type: 'TransactionCreated',
          timestamp: state.blockchain.currentTime,
          blockNumber: state.blockchain.blockNumber,
          data: { provider, requester, amount: amount.toString() },
        },
      ],
    };

    state.transactions[txId] = tx;

    // Return receipt
    return {
      transactionHash: txId,
      blockNumber: state.blockchain.blockNumber,
      gasUsed: BigNumber.from(85000), // Fake gas
      status: 1, // Success
      logs: [
        {
          address: '0xMockKernel',
          topics: ['TransactionCreated', txId],
          data: JSON.stringify(tx),
          blockNumber: state.blockchain.blockNumber,
          transactionHash: txId,
        },
      ],
    };
  }

  private handleAcceptTransaction(state: MockState, params: any[]): TransactionReceipt {
    const [txId] = params;

    const tx = state.transactions[txId];
    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    // Validate state transition
    if (tx.state !== 'INITIATED' && tx.state !== 'QUOTED') {
      throw new Error(`Cannot accept transaction in state: ${tx.state}`);
    }

    // Check deadline
    if (state.blockchain.currentTime > tx.deadline) {
      throw new Error('Deadline passed');
    }

    // Transition state
    tx.state = 'COMMITTED';
    tx.events.push({
      type: 'TransactionAccepted',
      timestamp: state.blockchain.currentTime,
      blockNumber: state.blockchain.blockNumber,
      data: { txId },
    });

    return this.createReceipt(state, txId, 'TransactionAccepted');
  }

  private handleTransitionState(state: MockState, params: any[]): TransactionReceipt {
    const [txId, newState] = params;

    const tx = state.transactions[txId];
    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    // Validate state transition (simplified - real contract has complex rules)
    const validTransitions: Record<string, string[]> = {
      INITIATED: ['QUOTED', 'CANCELLED'],
      QUOTED: ['COMMITTED', 'CANCELLED'],
      COMMITTED: ['IN_PROGRESS', 'CANCELLED'],
      IN_PROGRESS: ['DELIVERED'],
      DELIVERED: ['SETTLED', 'DISPUTED'],
      DISPUTED: ['SETTLED'],
    };

    if (!validTransitions[tx.state]?.includes(newState)) {
      throw new Error(`Invalid transition: ${tx.state} → ${newState}`);
    }

    // Apply transition
    const oldState = tx.state;
    tx.state = newState;
    tx.events.push({
      type: 'StateTransitioned',
      timestamp: state.blockchain.currentTime,
      blockNumber: state.blockchain.blockNumber,
      data: { txId, oldState, newState },
    });

    return this.createReceipt(state, txId, 'StateTransitioned');
  }

  private handleLinkEscrow(state: MockState, params: any[]): TransactionReceipt {
    const [txId, escrowId] = params;

    const tx = state.transactions[txId];
    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    // Create or update escrow
    if (!state.escrows[escrowId]) {
      state.escrows[escrowId] = {
        id: escrowId,
        balance: '0',
        locked: false,
        transactions: [],
      };
    }

    // Link escrow to transaction
    tx.escrowId = escrowId;
    state.escrows[escrowId].transactions.push(txId);

    // Lock funds (deduct from requester, add to escrow)
    const amount = BigNumber.from(tx.amount);
    this.deductBalance(state, tx.requester, amount);
    this.addEscrowBalance(state, escrowId, amount);

    // Auto-transition to COMMITTED (per ACTP spec)
    if (tx.state === 'INITIATED' || tx.state === 'QUOTED') {
      tx.state = 'COMMITTED';
    }

    tx.events.push({
      type: 'EscrowLinked',
      timestamp: state.blockchain.currentTime,
      blockNumber: state.blockchain.blockNumber,
      data: { txId, escrowId },
    });

    return this.createReceipt(state, txId, 'EscrowLinked');
  }

  private handleReleaseEscrow(state: MockState, params: any[]): TransactionReceipt {
    const [txId] = params;

    const tx = state.transactions[txId];
    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    if (tx.state !== 'DELIVERED') {
      throw new Error(`Cannot release escrow in state: ${tx.state}`);
    }

    if (!tx.escrowId) {
      throw new Error('No escrow linked');
    }

    // Release funds (escrow → provider)
    const amount = BigNumber.from(tx.amount);
    this.deductEscrowBalance(state, tx.escrowId, amount);
    this.addBalance(state, tx.provider, amount);

    // Transition to SETTLED
    tx.state = 'SETTLED';
    tx.events.push({
      type: 'EscrowReleased',
      timestamp: state.blockchain.currentTime,
      blockNumber: state.blockchain.blockNumber,
      data: { txId, provider: tx.provider, amount: amount.toString() },
    });

    return this.createReceipt(state, txId, 'EscrowReleased');
  }

  // --- Helper Methods ---

  private getTransaction(state: MockState, txId: string): any {
    const tx = state.transactions[txId];
    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }
    return tx;
  }

  private getBalance(state: MockState, address: string, token: string): BigNumber {
    if (token === 'USDC') {
      return this.getAccountBalance(state, address);
    }
    throw new Error(`Unsupported token: ${token}`);
  }

  private getAccountBalance(state: MockState, address: string): BigNumber {
    const account = state.accounts[address];
    if (!account) {
      return BigNumber.from(0);
    }
    return BigNumber.from(account.usdcBalance);
  }

  private addBalance(state: MockState, address: string, amount: BigNumber): void {
    if (!state.accounts[address]) {
      state.accounts[address] = { address, usdcBalance: '0' };
    }
    const current = BigNumber.from(state.accounts[address].usdcBalance);
    state.accounts[address].usdcBalance = current.add(amount).toString();
  }

  private deductBalance(state: MockState, address: string, amount: BigNumber): void {
    const current = this.getAccountBalance(state, address);
    if (current.lt(amount)) {
      throw new Error(`Insufficient balance: ${current.toString()} < ${amount.toString()}`);
    }
    state.accounts[address].usdcBalance = current.sub(amount).toString();
  }

  private addEscrowBalance(state: MockState, escrowId: string, amount: BigNumber): void {
    const current = BigNumber.from(state.escrows[escrowId].balance);
    state.escrows[escrowId].balance = current.add(amount).toString();
  }

  private deductEscrowBalance(state: MockState, escrowId: string, amount: BigNumber): void {
    const current = BigNumber.from(state.escrows[escrowId].balance);
    if (current.lt(amount)) {
      throw new Error(`Insufficient escrow balance: ${current.toString()} < ${amount.toString()}`);
    }
    state.escrows[escrowId].balance = current.sub(amount).toString();
  }

  private generateTxId(provider: string, requester: string, amount: BigNumber): string {
    // Simple hash (not cryptographically secure, but sufficient for mock)
    const input = `${provider}${requester}${amount.toString()}${Date.now()}`;
    return `0x${Buffer.from(input).toString('hex').slice(0, 64)}`;
  }

  private createReceipt(state: MockState, txId: string, eventType: string): TransactionReceipt {
    return {
      transactionHash: txId,
      blockNumber: state.blockchain.blockNumber,
      gasUsed: BigNumber.from(50000),
      status: 1,
      logs: [
        {
          address: '0xMockKernel',
          topics: [eventType, txId],
          data: JSON.stringify(state.transactions[txId]),
          blockNumber: state.blockchain.blockNumber,
          transactionHash: txId,
        },
      ],
    };
  }

  private matchesFilter(event: any, filter: any): boolean {
    // Simple filter matching (can be extended)
    for (const key in filter) {
      if (event.data[key] !== filter[key]) {
        return false;
      }
    }
    return true;
  }
}
```

### 2. What We DON'T Emulate

**Gas Mechanics**:
```typescript
// ❌ NOT IMPLEMENTED:
- Gas estimation (eth_estimateGas)
- Gas price markets (maxFeePerGas, maxPriorityFeePerGas)
- Gas limits (out of gas errors)
- EIP-1559 base fee calculation

// ✅ INSTEAD:
- All transactions succeed with fake gas: 50000-85000
- No gas-related failures
```

**Mempool/Mining**:
```typescript
// ❌ NOT IMPLEMENTED:
- Transaction pending state
- Mempool ordering (nonce, gas price)
- Block mining delay (~2 seconds)
- Transaction replacement (same nonce, higher gas)

// ✅ INSTEAD:
- Transactions execute instantly
- No concept of "pending" vs "confirmed"
```

**EVM Execution**:
```typescript
// ❌ NOT IMPLEMENTED:
- Solidity bytecode execution
- Opcode-level simulation
- Stack/memory/storage operations
- CREATE/CREATE2 contract deployment

// ✅ INSTEAD:
- High-level method handlers (hardcoded logic)
- No actual smart contract code runs
```

**Cryptography**:
```typescript
// ❌ NOT IMPLEMENTED:
- ECDSA signature verification
- keccak256 hashing
- ecrecover address derivation

// ✅ INSTEAD:
- Assume caller = signer (no signature checks)
- Simple hash functions (not cryptographic)
```

**Why This Is OK**:
- For **unit tests**: MockRuntime is sufficient
- For **integration tests**: Use Foundry anvil (real EVM)
- For **security tests**: Use Hardhat mainnet fork (real contracts)

## Consequences

### Positive

1. **Simple Implementation**: ~500 LOC vs thousands for full EVM emulation
2. **Fast**: No computation overhead, instant transactions
3. **Deterministic**: No race conditions, reorgs, or nonce issues
4. **Debuggable**: Plain TypeScript, no bytecode to reverse-engineer
5. **Maintainable**: Logic mirrors Solidity contracts (easy to keep in sync)
6. **Sufficient**: Covers 95% of SDK development use cases

### Negative

1. **Not Real Blockchain**: Can't catch gas optimization issues
   - Mitigation: Use Foundry for gas benchmarking
2. **No Signature Verification**: Can't test access control edge cases
   - Mitigation: Use Hardhat for security tests
3. **Simplified State Transitions**: Might miss complex reentrancy scenarios
   - Mitigation: Solidity tests have full coverage
4. **Divergence Risk**: Mock logic may differ from real contracts
   - Mitigation: CI runs tests against both mock and real testnet

### When to Use What

| Use Case | Tool | Reason |
|----------|------|--------|
| **Quick SDK iteration** | MockRuntime | Fast, no network |
| **Full transaction lifecycle** | MockRuntime | State persistence |
| **Gas optimization** | Foundry (forge) | Real EVM, gas reports |
| **Security audits** | Slither, Mythril | Static analysis |
| **Reentrancy testing** | Foundry (invariant tests) | Real EVM execution |
| **Mainnet fork testing** | Hardhat | Real contract interactions |
| **Integration with other protocols** | Testnet (Base Sepolia) | Real network |

## Alternatives Considered

### Alternative A: Full EVM Emulator (Ganache/Anvil)

**Embed Ganache or Anvil as library**:
```typescript
import { createGanacheProvider } from 'ganache';
const provider = createGanacheProvider();
```

**Pros**:
- 100% EVM-compatible
- Can deploy actual Solidity contracts
- Gas simulation, reorgs, everything

**Cons**:
- Heavy dependency (~50 MB)
- Slow startup (~500ms to initialize)
- Requires contract deployment on every test run
- State persistence is complex (need to snapshot EVM state)

**Decision**: Rejected. Too heavy for embedded SDK mock mode. Better as external tool.

### Alternative B: Hardhat Network as Embedded Mock

**Use Hardhat Network in-process**:
```typescript
import { HardhatNetwork } from 'hardhat/internal/hardhat-network';
const network = new HardhatNetwork();
```

**Pros**:
- Real EVM
- TypeScript-native
- Snapshot/revert support

**Cons**:
- Still requires contract deployment
- Hardhat is dev dependency (150+ MB node_modules)
- Not designed for embedding

**Decision**: Rejected. Use Hardhat as separate test environment, not embedded mock.

### Alternative C: Minimal State Machine (Our Choice)

**Implement just enough to test ACTP protocol**:
- Transaction lifecycle
- Balance tracking
- Event emission
- Time manipulation

**Decision**: Accepted. Best trade-off for MVP.

## Implementation Checklist

- [ ] Implement `MockRuntime` class (src/runtime/MockRuntime.ts)
- [ ] Implement transaction handlers (create, accept, transition, link, release)
- [ ] Implement balance tracking (accounts, escrows)
- [ ] Implement event emission and querying
- [ ] Implement time manipulation (advanceTime, setTime)
- [ ] Add validation (state transitions, deadlines, balances)
- [ ] Write unit tests (each handler, edge cases)
- [ ] Document divergence from real blockchain (this ADR)
- [ ] Add CI test: Run SDK tests against BOTH mock and testnet
- [ ] Create "Testing Guide" doc (when to use mock vs testnet vs mainnet fork)

## References

- [Ganache](https://github.com/trufflesuite/ganache) - Full EVM emulator
- [Anvil](https://book.getfoundry.sh/anvil/) - Foundry's local testnet
- [Hardhat Network](https://hardhat.org/hardhat-network/) - Built-in EVM
- [ethers.js MockProvider](https://docs.ethers.org/v5/api/providers/other/#MockProvider) - Lightweight mock (inspiration)
- [ACTP State Machine](../../Protocol/actp-kernel/COVENANT.md) - Source of truth for state transitions

## Future Enhancements

**Phase 2: Optional Realism Mode**
```typescript
// Enable gas simulation (for performance testing)
const runtime = new MockRuntime({
  simulateGas: true,
  blockTime: 2000, // 2-second blocks
  networkLatency: 100, // 100ms RPC delay
});
```

**Phase 3: Multi-Node Mock Network**
```typescript
// Simulate multiple nodes for testing consensus edge cases
const network = new MockNetwork({
  nodes: 3,
  consensusDelay: 500, // 500ms for finality
});
```

**Phase 4: Time Travel Snapshots**
```typescript
// Snapshot state, run tests, restore (like Hardhat)
const snapshotId = await runtime.snapshot();
await runtime.advanceTime(86400);
await runtime.revert(snapshotId);
```
