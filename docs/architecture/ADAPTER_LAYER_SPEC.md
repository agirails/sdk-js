# Three-Level API Adapter Layer Technical Specification

**Version:** 1.0
**Date:** December 12, 2025
**Status:** Final
**Related ADR:** ADR-002 (Adapter Layer Design)

---

## 1. Overview

The **Adapter Layer** bridges the gap between user-friendly Three-Level API and protocol-level SDK modules. It transforms high-level API calls with simple types (strings, optional parameters) into low-level protocol calls with strict types (BigNumber, addresses, timestamps).

**Key Responsibilities:**
- Type transformation (string → BigNumber, "+24h" → Unix timestamp)
- Smart defaults (implicit deadline, dispute window)
- Input validation (address format, amount parsing)
- Error formatting (user-friendly messages)

---

## 2. Architecture

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

---

## 3. Type Mapping Reference

| User Input | Adapter Transformation | Kernel Input |
|------------|------------------------|--------------|
| `to: "0xABC"` | `validateAddress()` | `provider: "0xABC"` |
| `amount: "100"` | `parseUnits("100", 6)` | `amount: BigNumber(100000000)` |
| `amount: "100 USDC"` | Strip suffix → parse | `amount: BigNumber(100000000)` |
| `amount: "100.50"` | Parse decimal | `amount: BigNumber(100500000)` |
| `deadline: "+24h"` | `now + 86400` | `deadline: 1734076400` |
| `deadline: undefined` | Default `+24h` | `deadline: 1734076400` |
| `disputeWindow: undefined` | Default `172800` | `disputeWindow: 172800` |
| (implicit) | `signer.getAddress()` | `requester: "0xDEF"` |

---

## 4. BaseAdapter Class

**File**: `src/adapters/BaseAdapter.ts`

### 4.1 Interface

```typescript
import { Signer } from 'ethers';
import { parseUnits, isAddress } from 'ethers/lib/utils';
import { BigNumber } from 'ethers';

export abstract class BaseAdapter {
  constructor(protected signer: Signer);

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
  protected parseAmount(amount: string | number): BigNumber;

  /**
   * Validate Ethereum address format
   */
  protected validateAddress(address: string, paramName: string): string;

  /**
   * Calculate deadline from relative time expression
   *
   * Accepts:
   * - 86400 → Unix timestamp (passed through)
   * - "+1h" → now + 1 hour
   * - "+24h" → now + 24 hours
   * - "+7d" → now + 7 days
   */
  protected parseDeadline(deadline?: string | number): number;

  /**
   * Get current signer address (for inferring requester)
   */
  protected async getSignerAddress(): Promise<string>;

  /**
   * Format BigNumber amount to human-readable string
   * @private
   */
  protected formatAmount(amount: BigNumber): string;
}

export class ValidationError extends Error {
  constructor(message: string);
}
```

### 4.2 Implementation

```typescript
// src/adapters/BaseAdapter.ts

import { Signer } from 'ethers';
import { parseUnits, isAddress, formatUnits } from 'ethers/lib/utils';
import { BigNumber } from 'ethers';

export abstract class BaseAdapter {
  constructor(protected signer: Signer) {}

  /**
   * Parse user-friendly amount string to BigNumber (USDC has 6 decimals)
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

    // Check for negative
    if (normalized.startsWith('-')) {
      throw new ValidationError('Amount cannot be negative');
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
   * Get current signer address
   */
  protected async getSignerAddress(): Promise<string> {
    return await this.signer.getAddress();
  }

  /**
   * Format BigNumber amount to human-readable string
   */
  protected formatAmount(amount: BigNumber): string {
    const formatted = formatUnits(amount, 6);
    return `${parseFloat(formatted).toFixed(2)} USDC`;
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
```

---

## 5. BeginnerAdapter

**File**: `src/adapters/BeginnerAdapter.ts`

### 5.1 Interface

```typescript
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

  /** Amount in USDC (human-readable, e.g., "100.00 USDC") */
  amount: string;

  /** Deadline as ISO 8601 timestamp */
  deadline: string;

  /** Transaction state */
  state: string;
}

export class BeginnerAdapter extends BaseAdapter {
  constructor(signer: Signer, kernel: KernelModule);

  /**
   * Create a payment transaction with smart defaults
   */
  async pay(params: BeginnerPayParams): Promise<BeginnerPayResult>;

  /**
   * Check payment status by transaction ID
   */
  async checkStatus(txId: string): Promise<{
    state: string;
    canAccept: boolean;
    canComplete: boolean;
    canDispute: boolean;
  }>;
}
```

### 5.2 Implementation

```typescript
// src/adapters/BeginnerAdapter.ts

import { BaseAdapter, ValidationError } from './BaseAdapter';
import { KernelModule } from '../protocol/Kernel';
import { CreateTransactionParams } from '../types';
import { Signer } from 'ethers';

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
}
```

### 5.3 Usage Examples

```typescript
import { ACTPClient } from '@agirails/sdk';

const client = await ACTPClient.create({ mode: 'mock' });

// Example 1: Simple payment (all defaults)
const result1 = await client.beginner.pay({
  to: '0xProvider123',
  amount: '100',
});
console.log('Transaction ID:', result1.txId);
console.log('Amount:', result1.amount); // "100.00 USDC"
console.log('Deadline:', result1.deadline); // ISO 8601 timestamp

// Example 2: Payment with custom deadline
const result2 = await client.beginner.pay({
  to: '0xProvider123',
  amount: '250.50 USDC', // With currency suffix
  deadline: '+7d', // 7 days from now
});

// Example 3: Check status
const status = await client.beginner.checkStatus(result1.txId);
if (status.canAccept) {
  console.log('Provider can accept this transaction');
}
```

---

## 6. IntermediateAdapter

**File**: `src/adapters/IntermediateAdapter.ts`

### 6.1 Interface

```typescript
export interface IntermediateTransactionParams {
  provider: string;
  amount: string | number;
  deadline?: string | number;  // Optional with smart default
  disputeWindow?: number;      // Optional with smart default
}

export class IntermediateAdapter extends BaseAdapter {
  constructor(signer: Signer, kernel: KernelModule, escrow: EscrowModule);

  /**
   * Create transaction (more explicit than beginner.pay())
   */
  async createTransaction(params: IntermediateTransactionParams): Promise<string>;

  /**
   * Accept transaction (provider side)
   */
  async acceptTransaction(txId: string): Promise<void>;

  /**
   * Complete transaction (provider side)
   */
  async completeTransaction(txId: string, proof: string): Promise<void>;

  /**
   * Release escrow (requester side)
   */
  async releaseEscrow(txId: string): Promise<void>;

  /**
   * Get escrow balance
   */
  async getEscrowBalance(escrowId: string): Promise<string>;
}
```

### 6.2 Implementation

```typescript
// src/adapters/IntermediateAdapter.ts

import { BaseAdapter } from './BaseAdapter';
import { KernelModule } from '../protocol/Kernel';
import { EscrowModule } from '../protocol/Escrow';
import { Signer } from 'ethers';
import { formatUnits } from 'ethers/lib/utils';

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
    return formatUnits(balance, 6); // "100.00"
  }
}
```

---

## 7. Integration into ACTPClient

**File**: `src/ACTPClient.ts`

```typescript
// src/ACTPClient.ts

import { BeginnerAdapter } from './adapters/BeginnerAdapter';
import { IntermediateAdapter } from './adapters/IntermediateAdapter';
import { KernelModule } from './protocol/Kernel';
import { EscrowModule } from './protocol/Escrow';
import { EventsModule } from './protocol/Events';

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

    const kernel = new KernelModule(provider, signer, config);
    const escrow = new EscrowModule(provider, signer, config);
    const events = new EventsModule(provider, config);

    return new ACTPClient(provider, signer, kernel, escrow, events);
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

---

## 8. Testing Strategy

### 8.1 Unit Tests (Adapters)

```typescript
// test/adapters/BaseAdapter.test.ts

import { BaseAdapter } from '../../src/adapters/BaseAdapter';
import { parseUnits } from 'ethers/lib/utils';

class TestAdapter extends BaseAdapter {}

describe('BaseAdapter', () => {
  let adapter: TestAdapter;

  beforeEach(() => {
    const mockSigner = { getAddress: async () => '0xRequester' } as any;
    adapter = new TestAdapter(mockSigner);
  });

  describe('parseAmount', () => {
    test('parses integer amount', () => {
      const result = adapter['parseAmount']('100');
      expect(result).toEqual(parseUnits('100', 6));
    });

    test('parses decimal amount', () => {
      const result = adapter['parseAmount']('100.50');
      expect(result).toEqual(parseUnits('100.50', 6));
    });

    test('strips currency suffix', () => {
      const result = adapter['parseAmount']('100 USDC');
      expect(result).toEqual(parseUnits('100', 6));
    });

    test('strips $ prefix', () => {
      const result = adapter['parseAmount']('$100');
      expect(result).toEqual(parseUnits('100', 6));
    });

    test('throws on invalid format', () => {
      expect(() => adapter['parseAmount']('abc')).toThrow('Invalid amount format');
    });

    test('throws on negative amount', () => {
      expect(() => adapter['parseAmount']('-100')).toThrow('cannot be negative');
    });
  });

  describe('parseDeadline', () => {
    test('defaults to +24h', () => {
      const now = Math.floor(Date.now() / 1000);
      const result = adapter['parseDeadline']();
      expect(result).toBeGreaterThanOrEqual(now + 86400);
      expect(result).toBeLessThan(now + 86401);
    });

    test('parses +1h', () => {
      const now = Math.floor(Date.now() / 1000);
      const result = adapter['parseDeadline']('+1h');
      expect(result).toBeGreaterThanOrEqual(now + 3600);
      expect(result).toBeLessThan(now + 3601);
    });

    test('parses +7d', () => {
      const now = Math.floor(Date.now() / 1000);
      const result = adapter['parseDeadline']('+7d');
      expect(result).toBeGreaterThanOrEqual(now + 7 * 86400);
      expect(result).toBeLessThan(now + 7 * 86400 + 1);
    });

    test('passes through Unix timestamp', () => {
      const timestamp = 1734076400;
      const result = adapter['parseDeadline'](timestamp);
      expect(result).toBe(timestamp);
    });

    test('throws on invalid format', () => {
      expect(() => adapter['parseDeadline']('invalid')).toThrow('Invalid deadline format');
    });
  });

  describe('validateAddress', () => {
    test('accepts valid address', () => {
      const address = '0x' + '1'.repeat(40);
      const result = adapter['validateAddress'](address, 'test');
      expect(result).toBe(address);
    });

    test('throws on invalid address', () => {
      expect(() => adapter['validateAddress']('invalid', 'test'))
        .toThrow('Invalid test address');
    });
  });
});
```

### 8.2 Integration Tests (Full Flow)

```typescript
// test/adapters/BeginnerAdapter.integration.test.ts

import { ACTPClient } from '../../src/ACTPClient';
import { parseUnits } from 'ethers/lib/utils';

describe('BeginnerAdapter Integration', () => {
  let client: ACTPClient;

  beforeEach(async () => {
    client = await ACTPClient.mock({
      deterministicSeed: 'test',
      initialBalance: '10000',
    });
  });

  test('pay() creates transaction with smart defaults', async () => {
    const result = await client.beginner.pay({
      to: '0x' + '1'.repeat(40),
      amount: '100',
    });

    expect(result.txId).toBeDefined();
    expect(result.amount).toBe('100.00 USDC');
    expect(result.state).toBe('INITIATED');

    // Verify transaction exists
    const tx = await client.kernel.getTransaction(result.txId);
    expect(tx.amount).toEqual(parseUnits('100', 6));
  });

  test('pay() throws on self-payment', async () => {
    const myAddress = await client.getAddress();

    await expect(
      client.beginner.pay({ to: myAddress, amount: '100' })
    ).rejects.toThrow('Cannot pay yourself');
  });

  test('checkStatus() returns correct state', async () => {
    const result = await client.beginner.pay({
      to: '0x' + '1'.repeat(40),
      amount: '100',
    });

    const status = await client.beginner.checkStatus(result.txId);
    expect(status.state).toBe('INITIATED');
    expect(status.canAccept).toBe(true);
    expect(status.canComplete).toBe(false);
  });
});
```

---

## 9. Error Handling

### 9.1 ValidationError

```typescript
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
```

**Usage**:
```typescript
try {
  await client.beginner.pay({ to: 'invalid', amount: '100' });
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('User input error:', error.message);
    // Show user-friendly error message
  }
}
```

### 9.2 Error Message Examples

| Invalid Input | Error Message |
|---------------|---------------|
| `amount: "abc"` | `Invalid amount format: "abc". Expected number or decimal (e.g., "100" or "100.50")` |
| `amount: "-100"` | `Amount cannot be negative` |
| `to: "invalid"` | `Invalid to address: "invalid". Expected 0x-prefixed hex string.` |
| `deadline: "invalid"` | `Invalid deadline format: "invalid". Expected Unix timestamp or relative time (e.g., "+24h", "+7d")` |
| `to: <same as requester>` | `Cannot pay yourself (requester == provider)` |
| `deadline: <past>` | `Deadline must be in the future` |

---

## 10. Performance Considerations

### 10.1 Overhead

| Operation | Time | Notes |
|-----------|------|-------|
| `parseAmount()` | <1ms | String parsing |
| `validateAddress()` | <1ms | Regex check |
| `parseDeadline()` | <1ms | String parsing |
| `getSignerAddress()` | ~1ms | Cached by ethers |
| **Total Adapter Overhead** | **~5ms** | Negligible |

**Comparison**:
- Adapter overhead: ~5ms
- Network RPC call: ~100-500ms
- Blockchain confirmation: ~2000ms

**Conclusion**: Adapter overhead is negligible (<1% of total request time).

---

## 11. Implementation Checklist

- [ ] Create `src/adapters/BaseAdapter.ts`
- [ ] Implement `parseAmount()` with currency suffix stripping
- [ ] Implement `validateAddress()` with clear error messages
- [ ] Implement `parseDeadline()` with relative time parsing
- [ ] Create `src/adapters/BeginnerAdapter.ts`
- [ ] Implement `pay()` with smart defaults
- [ ] Implement `checkStatus()` with state logic
- [ ] Create `src/adapters/IntermediateAdapter.ts`
- [ ] Implement intermediate methods (createTransaction, etc.)
- [ ] Update `ACTPClient` to instantiate adapters
- [ ] Write unit tests for BaseAdapter
- [ ] Write integration tests for BeginnerAdapter
- [ ] Add JSDoc comments for IntelliSense
- [ ] Update SDK documentation with examples

---

**Version:** 1.0
**Date:** December 12, 2025
**Status:** Final
