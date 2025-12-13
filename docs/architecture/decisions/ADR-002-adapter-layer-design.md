# ADR-002: Three-Level API Adapter Layer Design

## Status
**Accepted** - December 12, 2025

## Context

The AGIRAILS SDK exposes a **Three-Level API** to accommodate developers with different expertise levels:

1. **Beginner API**: High-level, opinionated (`pay()`, `checkStatus()`)
2. **Intermediate API**: Balanced control (`createTransaction()`, `acceptTransaction()`)
3. **Advanced API**: Full protocol access (direct `Kernel`, `Escrow`, `Events` modules)

**The Problem**: The existing SDK architecture has a type mismatch:

```typescript
// USER EXPECTATION (Beginner API):
await client.beginner.pay({
  to: "0xProvider123",
  amount: "100 USDC"
});

// ACTUAL KERNEL INTERFACE (Advanced API):
await client.kernel.createTransaction({
  provider: "0xProvider123",
  requester: "0xRequester456",      // ❌ User didn't provide this
  amount: parseUnits("100", 6),     // ❌ User gave string, kernel needs BigNumber
  deadline: 1734076400,             // ❌ User didn't provide this
  disputeWindow: 172800,            // ❌ User didn't provide this
  escrowId: "escrow-001"            // ❌ User didn't provide this
});
```

**Gap**: There's no layer that bridges user-friendly API calls to protocol-level parameters.

### Requirements

1. **Type Transformation**: Convert user-friendly types (strings, optional params) to protocol types (BigNumber, addresses, timestamps)
2. **Smart Defaults**: Apply sensible defaults for omitted parameters (24h deadline, 2-day dispute window)
3. **Validation**: Catch invalid inputs early (e.g., "not a number", invalid address)
4. **Consistency**: Same defaults across CLI, SDK, Dashboard
5. **Extensibility**: Easy to add new convenience methods without changing core protocol
6. **Testability**: Adapters can be unit tested independently of blockchain

### Design Constraints

- **No Breaking Changes**: Existing `Kernel.ts`, `Escrow.ts` interfaces remain unchanged
- **Minimal Dependencies**: No heavy validation libraries (Zod acceptable, Joi too heavy)
- **Clear Boundaries**: Adapters don't contain business logic, only translation
- **Performance**: <5ms overhead per call (parsing, validation)

## Decision

**We will implement an Adapter Layer** that sits between user-facing API classes and protocol modules:

```
┌─────────────────────────────────────┐
│   User Code                         │
│   client.beginner.pay(...)          │
└────────────┬────────────────────────┘
             │
┌────────────▼────────────────────────┐
│   Beginner API (src/api/)           │  ◄─── User-facing facade
│   - pay()                           │
│   - checkStatus()                   │
└────────────┬────────────────────────┘
             │
┌────────────▼────────────────────────┐
│   BeginnerAdapter (src/adapters/)   │  ◄─── Translation layer (NEW)
│   - parseAmount()                   │
│   - inferRequester()                │
│   - applyDefaults()                 │
└────────────┬────────────────────────┘
             │
┌────────────▼────────────────────────┐
│   Kernel Module (src/protocol/)     │  ◄─── Core protocol (unchanged)
│   - createTransaction()             │
└─────────────────────────────────────┘
```

## Architecture

### 1. Adapter Base Class

```typescript
// src/adapters/BaseAdapter.ts

import { Signer } from 'ethers';
import { parseUnits, isAddress } from 'ethers/lib/utils';
import { BigNumber } from 'ethers';

export abstract class BaseAdapter {
  constructor(protected signer: Signer) {}

  /**
   * Parse user-friendly amount string to BigNumber (USDC has 6 decimals)
   *
   * Accepts:
   * - "100" → 100000000 (100.00 USDC)
   * - "100.50" → 100500000 (100.50 USDC)
   * - "100 USDC" → 100000000 (strips currency suffix)
   * - "$100" → 100000000 (strips $ prefix)
   *
   * Rejects:
   * - "abc" → throws ValidationError
   * - "" → throws ValidationError
   * - "-100" → throws ValidationError (negative amounts)
   */
  protected parseAmount(amount: string | number): BigNumber {
    // Normalize input
    let normalized = String(amount).trim();

    // Strip currency symbols
    normalized = normalized
      .replace(/^[\$]/, '')        // Strip leading $
      .replace(/\s*(USDC|usdc)$/, '') // Strip trailing USDC
      .replace(/,/g, '');          // Strip thousands separators

    // Validate format
    if (!/^\d+(\.\d{1,6})?$/.test(normalized)) {
      throw new ValidationError(
        `Invalid amount format: "${amount}". Expected number or decimal (e.g., "100" or "100.50")`
      );
    }

    // Parse to BigNumber
    try {
      return parseUnits(normalized, 6); // USDC has 6 decimals
    } catch (error) {
      throw new ValidationError(`Failed to parse amount: ${error.message}`);
    }
  }

  /**
   * Validate Ethereum address format
   */
  protected validateAddress(address: string, paramName: string): string {
    if (!isAddress(address)) {
      throw new ValidationError(
        `Invalid ${paramName} address: "${address}". Expected 0x-prefixed hex string.`
      );
    }
    return address;
  }

  /**
   * Calculate deadline from relative time expression
   *
   * Accepts:
   * - 86400 → Unix timestamp (passed through)
   * - "+1h" → now + 1 hour
   * - "+24h" → now + 24 hours
   * - "+7d" → now + 7 days
   */
  protected parseDeadline(deadline?: string | number): number {
    if (!deadline) {
      // Default: 24 hours from now
      return Math.floor(Date.now() / 1000) + 86400;
    }

    if (typeof deadline === 'number') {
      return deadline;
    }

    // Parse relative time
    const match = deadline.match(/^\+(\d+)(h|d)$/);
    if (!match) {
      throw new ValidationError(
        `Invalid deadline format: "${deadline}". Expected Unix timestamp or relative time (e.g., "+24h", "+7d")`
      );
    }

    const [, amount, unit] = match;
    const multiplier = unit === 'h' ? 3600 : 86400;
    return Math.floor(Date.now() / 1000) + parseInt(amount) * multiplier;
  }

  /**
   * Get current signer address (for inferring requester)
   */
  protected async getSignerAddress(): Promise<string> {
    return await this.signer.getAddress();
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
```

### 2. BeginnerAdapter Implementation

```typescript
// src/adapters/BeginnerAdapter.ts

import { BaseAdapter, ValidationError } from './BaseAdapter';
import { KernelModule } from '../protocol/Kernel';
import { CreateTransactionParams } from '../types';

export interface BeginnerPayParams {
  /** Recipient address (provider) */
  to: string;

  /** Amount in user-friendly format ("100", "100.50", "100 USDC") */
  amount: string | number;

  /** Optional: Deadline as relative time ("+24h") or Unix timestamp. Defaults to +24h */
  deadline?: string | number;

  /** Optional: Dispute window in seconds. Defaults to 172800 (2 days) */
  disputeWindow?: number;
}

export interface BeginnerPayResult {
  /** Transaction ID (hash) */
  txId: string;

  /** Provider address */
  provider: string;

  /** Requester address (caller) */
  requester: string;

  /** Amount in USDC (human-readable, e.g., "100.00") */
  amount: string;

  /** Deadline as ISO 8601 timestamp */
  deadline: string;

  /** Transaction state */
  state: string;
}

export class BeginnerAdapter extends BaseAdapter {
  constructor(
    signer: Signer,
    private kernel: KernelModule
  ) {
    super(signer);
  }

  /**
   * Create a payment transaction with smart defaults
   */
  async pay(params: BeginnerPayParams): Promise<BeginnerPayResult> {
    // Validate inputs
    const provider = this.validateAddress(params.to, 'to');
    const amount = this.parseAmount(params.amount);
    const deadline = this.parseDeadline(params.deadline);
    const disputeWindow = params.disputeWindow || 172800; // Default: 2 days

    // Infer requester from signer
    const requester = await this.getSignerAddress();

    // Additional validations
    if (requester.toLowerCase() === provider.toLowerCase()) {
      throw new ValidationError('Cannot pay yourself (requester == provider)');
    }

    if (deadline <= Math.floor(Date.now() / 1000)) {
      throw new ValidationError('Deadline must be in the future');
    }

    // Create protocol-level transaction
    const createParams: CreateTransactionParams = {
      provider,
      requester,
      amount,
      deadline,
      disputeWindow,
      // escrowId is auto-generated by kernel
    };

    const txId = await this.kernel.createTransaction(createParams);

    // Fetch transaction details for user-friendly response
    const tx = await this.kernel.getTransaction(txId);

    return {
      txId,
      provider,
      requester,
      amount: this.formatAmount(amount), // "100.00 USDC"
      deadline: new Date(deadline * 1000).toISOString(),
      state: tx.state,
    };
  }

  /**
   * Check payment status by transaction ID
   */
  async checkStatus(txId: string): Promise<{
    state: string;
    canAccept: boolean;
    canComplete: boolean;
    canDispute: boolean;
  }> {
    const tx = await this.kernel.getTransaction(txId);
    const now = Math.floor(Date.now() / 1000);

    return {
      state: tx.state,
      canAccept: tx.state === 'INITIATED' && tx.deadline > now,
      canComplete: tx.state === 'COMMITTED',
      canDispute: tx.state === 'DELIVERED' && tx.completedAt + tx.disputeWindow > now,
    };
  }

  /**
   * Format BigNumber amount to human-readable string
   * @private
   */
  private formatAmount(amount: BigNumber): string {
    const formatted = ethers.utils.formatUnits(amount, 6);
    return `${parseFloat(formatted).toFixed(2)} USDC`;
  }
}
```

### 3. IntermediateAdapter Implementation

```typescript
// src/adapters/IntermediateAdapter.ts

import { BaseAdapter } from './BaseAdapter';
import { KernelModule } from '../protocol/Kernel';
import { EscrowModule } from '../protocol/Escrow';

export interface IntermediateTransactionParams {
  provider: string;
  amount: string | number;
  deadline?: string | number;  // Optional with smart default
  disputeWindow?: number;      // Optional with smart default
}

export class IntermediateAdapter extends BaseAdapter {
  constructor(
    signer: Signer,
    private kernel: KernelModule,
    private escrow: EscrowModule
  ) {
    super(signer);
  }

  /**
   * Create transaction (more explicit than beginner.pay())
   */
  async createTransaction(params: IntermediateTransactionParams): Promise<string> {
    const provider = this.validateAddress(params.provider, 'provider');
    const requester = await this.getSignerAddress();
    const amount = this.parseAmount(params.amount);
    const deadline = this.parseDeadline(params.deadline);
    const disputeWindow = params.disputeWindow || 172800;

    return this.kernel.createTransaction({
      provider,
      requester,
      amount,
      deadline,
      disputeWindow,
    });
  }

  /**
   * Accept transaction (provider side)
   */
  async acceptTransaction(txId: string): Promise<void> {
    await this.kernel.acceptTransaction(txId);
  }

  /**
   * Complete transaction (provider side)
   */
  async completeTransaction(txId: string, proof: string): Promise<void> {
    await this.kernel.completeTransaction(txId, proof);
  }

  /**
   * Release escrow (requester side)
   */
  async releaseEscrow(txId: string): Promise<void> {
    await this.kernel.releaseEscrow(txId);
  }

  /**
   * Get escrow balance
   */
  async getEscrowBalance(escrowId: string): Promise<string> {
    const balance = await this.escrow.getBalance(escrowId);
    return ethers.utils.formatUnits(balance, 6);
  }
}
```

### 4. Integration into ACTPClient

```typescript
// src/ACTPClient.ts (updated)

import { BeginnerAdapter } from './adapters/BeginnerAdapter';
import { IntermediateAdapter } from './adapters/IntermediateAdapter';
import { KernelModule } from './protocol/Kernel';
import { EscrowModule } from './protocol/Escrow';

export class ACTPClient {
  // Adapters (user-facing APIs)
  readonly beginner: BeginnerAdapter;
  readonly intermediate: IntermediateAdapter;

  // Core protocol modules (advanced API)
  readonly kernel: KernelModule;
  readonly escrow: EscrowModule;
  readonly events: EventsModule;

  private constructor(
    private provider: Provider,
    private signer: Signer,
    kernel: KernelModule,
    escrow: EscrowModule,
    events: EventsModule
  ) {
    this.kernel = kernel;
    this.escrow = escrow;
    this.events = events;

    // Initialize adapters
    this.beginner = new BeginnerAdapter(signer, kernel);
    this.intermediate = new IntermediateAdapter(signer, kernel, escrow);
  }

  static async create(config: ClientConfig): Promise<ACTPClient> {
    // ... (existing factory logic)
  }

  // Alias for backward compatibility
  get advanced() {
    return {
      kernel: this.kernel,
      escrow: this.escrow,
      events: this.events,
    };
  }
}
```

## Type Mapping Reference

| User Input | Adapter Transformation | Kernel Input |
|------------|------------------------|--------------|
| `to: "0xABC"` | `validateAddress()` | `provider: "0xABC"` |
| `amount: "100"` | `parseUnits("100", 6)` | `amount: BigNumber(100000000)` |
| `amount: "100 USDC"` | Strip suffix → parse | `amount: BigNumber(100000000)` |
| `deadline: "+24h"` | `now + 86400` | `deadline: 1734076400` |
| `deadline: undefined` | Default `+24h` | `deadline: 1734076400` |
| `disputeWindow: undefined` | Default `172800` | `disputeWindow: 172800` |
| (implicit) | `signer.getAddress()` | `requester: "0xDEF"` |

## Consequences

### Positive

1. **Backward Compatible**: Existing `Kernel.ts` API unchanged - no breaking changes
2. **User-Friendly**: Developers can write `pay("0xABC", "100")` instead of BigNumber math
3. **Testable**: Adapters can be unit tested without blockchain (mock signer)
4. **Consistent Defaults**: Same 24h deadline, 2-day dispute window everywhere
5. **Clear Separation**: Business logic (Kernel) vs. convenience (Adapter)
6. **Extensible**: Add new methods (e.g., `payWithMemo()`) without touching core

### Negative

1. **Extra Layer**: Adds indirection (1-2 function calls deeper)
   - Mitigation: <5ms overhead, negligible compared to RPC calls
2. **Duplicate Validation**: Some checks done in adapter AND kernel
   - Mitigation: Adapter validation is user-friendly, kernel is security-critical
3. **Code Duplication**: Similar parsing logic across adapters
   - Mitigation: BaseAdapter reduces duplication

### Migration Path

Existing users (if any) using direct Kernel access:

```typescript
// Old way (still works - no breaking change)
await client.kernel.createTransaction({
  provider: "0xABC",
  requester: await client.signer.getAddress(),
  amount: parseUnits("100", 6),
  deadline: Math.floor(Date.now() / 1000) + 86400,
  disputeWindow: 172800,
});

// New beginner way
await client.beginner.pay({
  to: "0xABC",
  amount: "100",
});

// New intermediate way
await client.intermediate.createTransaction({
  provider: "0xABC",
  amount: "100",
  deadline: "+24h",
});
```

## Alternatives Considered

### Alternative A: Overload Kernel Methods

Add overloaded signatures to `Kernel.createTransaction()`:

```typescript
class KernelModule {
  createTransaction(params: CreateTransactionParams): Promise<string>;
  createTransaction(to: string, amount: string): Promise<string>; // Overload
}
```

**Rejected** because:
- Violates single responsibility (Kernel does protocol + convenience)
- Makes testing harder (need to test all overload combinations)
- Can't have different names for clarity (`pay()` vs `createTransaction()`)

### Alternative B: Static Helper Functions

```typescript
// src/utils/helpers.ts
export async function pay(client: ACTPClient, to: string, amount: string) {
  // ...
}

// Usage
import { pay } from '@agirails/sdk/helpers';
await pay(client, "0xABC", "100");
```

**Rejected** because:
- Not discoverable (no IntelliSense on `client.`)
- Doesn't enforce consistent defaults
- Hard to group related methods (pay, checkStatus, etc.)

### Alternative C: Builder Pattern

```typescript
await client.transaction()
  .to("0xABC")
  .amount("100")
  .deadline("+24h")
  .create();
```

**Rejected** because:
- Overkill for simple API
- More complex to implement and test
- Doesn't align with "beginner-friendly" goal

## Implementation Checklist

- [ ] Create `BaseAdapter` class with shared utilities
- [ ] Implement `BeginnerAdapter` with `pay()` and `checkStatus()`
- [ ] Implement `IntermediateAdapter` with full transaction lifecycle
- [ ] Update `ACTPClient` to instantiate adapters
- [ ] Write unit tests for each adapter (mock Kernel/Escrow)
- [ ] Write integration tests (mock runtime)
- [ ] Add JSDoc comments for IntelliSense
- [ ] Update SDK documentation with Three-Level API examples
- [ ] Add error handling guide (ValidationError vs ProtocolError)

## References

- [Adapter Pattern](https://refactoring.guru/design-patterns/adapter) - Classic GoF pattern
- [ethers.js Utilities](https://docs.ethers.org/v5/api/utils/) - parseUnits, formatUnits
- [Stripe API Design](https://stripe.com/docs/api) - Inspiration for user-friendly APIs
