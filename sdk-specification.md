# ACTP SDK Specification v1.0
## Protocol-First SDK for Agent Commerce

**Date:** November 15, 2025  
**Status:** Draft for Implementation  
**Target:** TypeScript/JavaScript (Primary), Python (Secondary)

---

## 0. Document Overview

### 0.1. Purpose

This document specifies the **ACTP SDK** — a developer toolkit for building applications on top of the **Agent Commerce Transaction Protocol (ACTP)**. The SDK provides two distinct layers:

1. **Protocol SDK (MVP)** — Direct blockchain interaction with ACTP Kernel smart contracts
2. **Platform SDK (Future)** — High-level API for AGIRAILS managed platform services

**For testnet deployment and initial integrations (n8n, LangChain), the Protocol SDK is the critical path.**

### 0.2. Canonical References

| Document | Purpose | Relevant Sections |
|----------|---------|-------------------|
| **Yellow Paper v3.1** | ACTP protocol specification | §3 (Kernel), §4-10 (AIPs), §11 (Security) |
| **White Paper v2.1** | Business logic & state machine | §4.4 (ACTP Overview) |
| **Blue Paper v2.1** | Architecture & implementation | §1 (Layered Architecture) |
| **ACTPKernel.sol** | Smart contract implementation | `/Testnet/ACTP-Kernel/src/ACTPKernel.sol` |

### 0.3. Repositories

| Component | Repo | License | Status |
|-----------|------|---------|--------|
| **TypeScript SDK** | `github.com/agirails/sdk-js` | Apache 2.0 | ✅ Published (npm @agirails/sdk) |
| **Python SDK** | `github.com/agirails/actp-sdk-python` | Apache 2.0 | 📋 Planned (Q2 2026) |
| **n8n Node** | `github.com/agirails/n8n-nodes-actp` | MIT | 📋 Planned (Q1 2026) |

### 0.4. Distribution

- **NPM:** `@agirails/sdk` (TypeScript/JavaScript)
- **PyPI:** `agirails-sdk` (Python)
- **Version Strategy:** SemVer 2.0 (0.x.x for pre-1.0 releases)

---

## 1. Architecture Overview

### 1.1. Two-Layer SDK Design

```
┌─────────────────────────────────────────────────────────┐
│              APPLICATION LAYER (Future)                  │
│  AGIRAILS Platform API: Managed wallets, discovery,     │
│  agent registry, analytics dashboard                     │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│           PLATFORM SDK (Future - Post-MVP)               │
│  High-level: client.agents.register()                   │
│             client.transactions.create()                 │
│             client.discovery.search()                    │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│           PROTOCOL SDK (MVP - Priority 1)                │
│  Direct blockchain: ACTPKernel.createTransaction()      │
│                     ACTPKernel.transitionState()         │
│                     EscrowVault.createEscrow()           │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│              BLOCKCHAIN LAYER                            │
│  Base Sepolia Testnet → Base Mainnet                    │
│  ACTP Kernel (0x...) + EscrowVault (0x...) + USDC       │
└─────────────────────────────────────────────────────────┘
```

**Key Principle:** Protocol SDK is **chain-native, trust-minimized** — no central API dependency. Platform SDK adds **convenience & managed services** on top.

### 1.2. SDK Components

```typescript
@agirails/sdk
├── /protocol          // MVP: Direct blockchain interaction
│   ├── ACTPKernel     // Smart contract wrapper
│   ├── EscrowVault    // Escrow contract wrapper
│   ├── StateMachine   // ACTP state validation
│   ├── MessageSigner  // Cryptographic signing
│   ├── EventMonitor   // Blockchain event listening
│   └── ProofGenerator // Content hashing & proofs
│
├── /platform          // Future: Managed platform API
│   ├── AgentsAPI      // Agent registration & management
│   ├── DiscoveryAPI   // Service discovery
│   ├── WalletAPI      // Managed wallet services
│   └── AnalyticsAPI   // Transaction analytics
│
├── /types             // TypeScript types & interfaces
│   ├── ACTPTypes      // Core protocol types
│   ├── AIPSchemas     // AIP message schemas
│   └── StateTypes     // State machine enums
│
└── /utils             // Shared utilities
    ├── NetworkConfig  // Chain configs & addresses
    ├── ErrorHandling  // Custom error classes
    └── Validation     // Input validation
```

---

## 2. Protocol SDK (MVP) — Testnet Priority

**Target:** Week 2-3 of development  
**Goal:** Enable direct interaction with deployed ACTP Kernel contracts on Base Sepolia

### 2.1. Core Classes

#### 2.1.1. ACTPClient (Entry Point)

```typescript
import { ACTPClient } from '@agirails/sdk';

// Initialize client
const client = new ACTPClient({
  network: 'base-sepolia',
  privateKey: process.env.PRIVATE_KEY, // Local wallet
  rpcUrl: 'https://sepolia.base.org',  // Optional: custom RPC
});

// Access sub-modules
const kernel = client.kernel;   // ACTPKernel contract
const escrow = client.escrow;   // EscrowVault contract
const events = client.events;   // Event monitoring
```

**Configuration Interface:**

```typescript
interface ACTPClientConfig {
  network: 'base-sepolia' | 'base-mainnet';
  privateKey?: string;              // For local wallet
  signer?: ethers.Signer;           // Or provide custom signer
  rpcUrl?: string;                  // Override default RPC
  contracts?: {                     // Override contract addresses
    actpKernel?: string;
    escrowVault?: string;
    usdc?: string;
  };
  gasSettings?: {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  };
}
```

---

#### 2.1.2. ACTPKernel (Smart Contract Wrapper)

**Reference:** Yellow Paper §3 (ACTP Kernel Specification)

```typescript
class ACTPKernel {
  private contract: ethers.Contract;
  private signer: ethers.Signer;

  // Transaction Creation (Yellow Paper §3.4.1)
  async createTransaction(params: CreateTransactionParams): Promise<string> {
    const {
      provider,
      requester,
      amount,          // in USDC (wei units: amount * 1e6)
      deadline,        // Unix timestamp
      disputeWindow,   // seconds (max: 30 days)
      metadata         // Optional: IPFS hash of service agreement
    } = params;

    const tx = await this.contract.createTransaction(
      provider,
      requester,
      amount,
      deadline,
      disputeWindow,
      metadata || ethers.constants.HashZero,
      { gasLimit: 200000 } // Estimated gas
    );

    const receipt = await tx.wait();
    const txId = this.extractTransactionId(receipt);
    
    return txId; // Returns bytes32 transaction ID
  }

  // State Transitions (Yellow Paper §3.2)
  async transitionState(
    txId: string,
    newState: State,
    proof?: bytes
  ): Promise<void> {
    // Validate transition is allowed
    const currentTx = await this.getTransaction(txId);
    if (!isValidTransition(currentTx.state, newState)) {
      throw new InvalidStateTransitionError(currentTx.state, newState);
    }

    const tx = await this.contract.transitionState(
      txId,
      newState,
      proof || '0x',
      { gasLimit: 150000 }
    );

    await tx.wait();
  }

  // Escrow Linking (Yellow Paper §3.4.2)
  async linkEscrow(
    txId: string,
    escrowContract: string,
    escrowId: string
  ): Promise<void> {
    const tx = await this.contract.linkEscrow(
      txId,
      escrowContract,
      escrowId,
      { gasLimit: 100000 }
    );

    await tx.wait();
  }

  // Milestone Release (for partial payments)
  async releaseMilestone(
    txId: string,
    milestoneId: number,
    amount: bigint
  ): Promise<void> {
    const tx = await this.contract.releaseMilestone(
      txId,
      milestoneId,
      amount,
      { gasLimit: 180000 }
    );

    await tx.wait();
  }

  // Escrow Release (final settlement)
  async releaseEscrow(txId: string): Promise<void> {
    const tx = await this.contract.releaseEscrow(txId, {
      gasLimit: 200000
    });

    await tx.wait();
  }

  // Dispute Management
  async raiseDispute(
    txId: string,
    reason: string,
    evidence: string // IPFS hash
  ): Promise<void> {
    const proofData = ethers.utils.defaultAbiCoder.encode(
      ['string', 'string'],
      [reason, evidence]
    );

    await this.transitionState(txId, State.DISPUTED, proofData);
  }

  async resolveDispute(
    txId: string,
    resolution: DisputeResolution
  ): Promise<void> {
    const { requesterAmount, providerAmount, mediatorAmount, mediator } = resolution;

    const proofData = ethers.utils.defaultAbiCoder.encode(
      ['uint256', 'uint256', 'uint256', 'address'],
      [requesterAmount, providerAmount, mediatorAmount, mediator || ethers.constants.AddressZero]
    );

    const tx = await this.contract.settleDispute(
      txId,
      proofData,
      { gasLimit: 250000 }
    );

    await tx.wait();
  }

  // Transaction Query
  async getTransaction(txId: string): Promise<Transaction> {
    const txData = await this.contract.transactions(txId);

    return {
      txId,
      requester: txData.requester,
      provider: txData.provider,
      amount: txData.amount,
      state: txData.state as State,
      createdAt: txData.createdAt.toNumber(),
      deadline: txData.deadline.toNumber(),
      disputeWindow: txData.disputeWindow.toNumber(),
      escrowContract: txData.escrowContract,
      escrowId: txData.escrowId,
      metadata: txData.metadata
    };
  }

  // Economic Parameters (Admin only)
  async getEconomicParams(): Promise<EconomicParams> {
    const params = await this.contract.getEconomicParams();
    return {
      baseFeeNumerator: params.baseFeeNumerator.toNumber(),
      baseFeeDenominator: params.baseFeeDenominator.toNumber(),
      feeRecipient: params.feeRecipient,
      requesterPenaltyBps: params.requesterPenaltyBps.toNumber(),
      providerPenaltyBps: params.providerPenaltyBps.toNumber()
    };
  }
}
```

**Type Definitions:**

```typescript
interface CreateTransactionParams {
  provider: string;       // Provider address
  requester: string;      // Requester address
  amount: bigint;         // Amount in USDC (wei: amount * 1e6)
  deadline: number;       // Unix timestamp
  disputeWindow: number;  // Seconds (max: 2592000 = 30 days)
  metadata?: string;      // Optional: bytes32 hash
}

interface Transaction {
  txId: string;
  requester: string;
  provider: string;
  amount: bigint;
  state: State;
  createdAt: number;
  deadline: number;
  disputeWindow: number;
  escrowContract: string;
  escrowId: string;
  metadata: string;
}

interface DisputeResolution {
  requesterAmount: bigint;
  providerAmount: bigint;
  mediatorAmount: bigint;
  mediator?: string;
}

interface EconomicParams {
  baseFeeNumerator: number;      // e.g., 100 (for 1%)
  baseFeeDenominator: number;    // e.g., 10000
  feeRecipient: string;
  requesterPenaltyBps: number;   // Basis points (100 = 1%)
  providerPenaltyBps: number;
}
```

---

#### 2.1.3. State Machine (Yellow Paper §3.2)

```typescript
enum State {
  INITIATED = 0,
  QUOTED = 1,
  COMMITTED = 2,
  IN_PROGRESS = 3,
  DELIVERED = 4,
  SETTLED = 5,
  DISPUTED = 6,
  CANCELLED = 7
}

class StateMachine {
  // Valid state transitions (Yellow Paper §3.2.2)
  private static transitions: Record<State, State[]> = {
    [State.INITIATED]: [State.QUOTED, State.CANCELLED],
    [State.QUOTED]: [State.COMMITTED, State.CANCELLED],
    [State.COMMITTED]: [State.IN_PROGRESS, State.CANCELLED],
    [State.IN_PROGRESS]: [State.DELIVERED, State.DISPUTED],
    [State.DELIVERED]: [State.SETTLED, State.DISPUTED],
    [State.DISPUTED]: [State.SETTLED, State.CANCELLED],
    [State.SETTLED]: [], // Terminal state
    [State.CANCELLED]: [] // Terminal state
  };

  static isValidTransition(from: State, to: State): boolean {
    return this.transitions[from]?.includes(to) ?? false;
  }

  static isTerminalState(state: State): boolean {
    return state === State.SETTLED || state === State.CANCELLED;
  }

  static getStateName(state: State): string {
    return State[state];
  }

  static getNextValidStates(currentState: State): State[] {
    return this.transitions[currentState] || [];
  }
}

class InvalidStateTransitionError extends Error {
  constructor(from: State, to: State) {
    super(
      `Invalid state transition: ${State[from]} (${from}) → ${State[to]} (${to}). ` +
      `Valid transitions from ${State[from]}: ${StateMachine.getNextValidStates(from).map(s => State[s]).join(', ')}`
    );
    this.name = 'InvalidStateTransitionError';
  }
}
```

---

#### 2.1.4. EscrowVault (Smart Contract Wrapper)

```typescript
class EscrowVault {
  private contract: ethers.Contract;
  private signer: ethers.Signer;

  async createEscrow(params: CreateEscrowParams): Promise<string> {
    const { kernelAddress, txId, token, amount, beneficiary } = params;

    // Approve token transfer first
    const tokenContract = new ethers.Contract(
      token,
      ['function approve(address spender, uint256 amount) returns (bool)'],
      this.signer
    );

    const approveTx = await tokenContract.approve(
      this.contract.address,
      amount
    );
    await approveTx.wait();

    // Create escrow
    const tx = await this.contract.createEscrow(
      kernelAddress,
      txId,
      token,
      amount,
      beneficiary,
      { gasLimit: 200000 }
    );

    const receipt = await tx.wait();
    const escrowId = this.extractEscrowId(receipt);

    return escrowId;
  }

  async getEscrowBalance(escrowId: string): Promise<bigint> {
    const escrow = await this.contract.escrows(escrowId);
    return escrow.amount;
  }

  async releaseEscrow(
    escrowId: string,
    recipients: string[],
    amounts: bigint[]
  ): Promise<void> {
    const tx = await this.contract.disburse(
      escrowId,
      recipients,
      amounts,
      { gasLimit: 250000 }
    );

    await tx.wait();
  }

  private extractEscrowId(receipt: ethers.ContractReceipt): string {
    const event = receipt.events?.find(e => e.event === 'EscrowCreated');
    return event?.args?.escrowId || '';
  }
}

interface CreateEscrowParams {
  kernelAddress: string;
  txId: string;
  token: string;        // USDC address
  amount: bigint;
  beneficiary: string;  // Provider address
}
```

---

#### 2.1.5. MessageSigner (Yellow Paper §11.4.2)

**Cryptographic signing for ACTP messages**

```typescript
class MessageSigner {
  constructor(private signer: ethers.Signer) {}

  // Sign any ACTP message
  async signMessage(message: ACTPMessage): Promise<string> {
    const messageHash = this.hashMessage(message);
    const signature = await this.signer.signMessage(
      ethers.utils.arrayify(messageHash)
    );
    return signature;
  }

  // Verify message signature
  async verifySignature(
    message: ACTPMessage,
    signature: string
  ): Promise<boolean> {
    const messageHash = this.hashMessage(message);
    const recoveredAddress = ethers.utils.verifyMessage(
      ethers.utils.arrayify(messageHash),
      signature
    );

    const expectedAddress = this.didToAddress(message.from);
    return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
  }

  // Hash message for signing (Yellow Paper §11.4.1)
  private hashMessage(message: ACTPMessage): string {
    const { type, from, to, timestamp, nonce, ...payload } = message;

    return ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ['string', 'string', 'string', 'uint256', 'bytes32', 'bytes'],
        [
          type,
          from,
          to,
          timestamp,
          nonce,
          ethers.utils.toUtf8Bytes(JSON.stringify(payload))
        ]
      )
    );
  }

  private didToAddress(did: string): string {
    // MVP: Simple did:ethr → address conversion
    return did.replace('did:ethr:', '');
  }
}

interface ACTPMessage {
  type: string;        // e.g., 'quote.request', 'delivery.proof'
  version: string;     // e.g., '1.0'
  from: string;        // DID
  to: string;          // DID
  timestamp: number;   // Unix timestamp
  nonce: string;       // Unique ID (bytes32)
  [key: string]: any;  // Message-specific payload
}
```

---

#### 2.1.6. ProofGenerator (Yellow Paper §11.4.1)

**Content hashing and delivery proof generation**

```typescript
class ProofGenerator {
  // Hash deliverable content
  hashContent(content: string | Buffer): string {
    const buffer = typeof content === 'string'
      ? ethers.utils.toUtf8Bytes(content)
      : content;

    return ethers.utils.keccak256(buffer);
  }

  // Generate delivery proof (AIP-4)
  generateDeliveryProof(params: DeliveryProofParams): DeliveryProof {
    const { txId, deliverable, metadata } = params;

    const contentHash = this.hashContent(deliverable);

    return {
      txId,
      contentHash,
      timestamp: Date.now(),
      metadata: {
        size: deliverable.length,
        mimeType: metadata?.mimeType || 'application/octet-stream',
        ...metadata
      }
    };
  }

  // Encode proof for on-chain submission
  encodeProof(proof: DeliveryProof): string {
    return ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'bytes32', 'uint256'],
      [proof.txId, proof.contentHash, proof.timestamp]
    );
  }

  // Verify deliverable matches proof
  verifyDeliverable(
    deliverable: string | Buffer,
    expectedHash: string
  ): boolean {
    const actualHash = this.hashContent(deliverable);
    return actualHash === expectedHash;
  }
}

interface DeliveryProofParams {
  txId: string;
  deliverable: string | Buffer;
  metadata?: Record<string, any>;
}

interface DeliveryProof {
  txId: string;
  contentHash: string;
  timestamp: number;
  metadata: Record<string, any>;
}
```

---

#### 2.1.7. EventMonitor (Blockchain Event Listening)

```typescript
class EventMonitor {
  constructor(
    private kernel: ethers.Contract,
    private escrow: ethers.Contract
  ) {}

  // Watch transaction lifecycle
  async watchTransaction(
    txId: string,
    callback: (state: State) => void
  ): Promise<() => void> {
    const filter = this.kernel.filters.StateTransitioned(txId);

    const listener = (
      eventTxId: string,
      from: number,
      to: number,
      event: ethers.Event
    ) => {
      callback(to as State);
    };

    this.kernel.on(filter, listener);

    // Return cleanup function
    return () => this.kernel.off(filter, listener);
  }

  // Wait for specific state
  async waitForState(
    txId: string,
    targetState: State,
    timeout: number = 60000 // 1 minute default
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for state ${State[targetState]}`));
      }, timeout);

      const cleanup = this.watchTransaction(txId, (state) => {
        if (state === targetState) {
          clearTimeout(timer);
          cleanup();
          resolve();
        }
      });
    });
  }

  // Get all transactions for an address
  async getTransactionHistory(
    address: string,
    role: 'requester' | 'provider' = 'requester'
  ): Promise<Transaction[]> {
    const filter = role === 'requester'
      ? this.kernel.filters.TransactionCreated(null, address)
      : this.kernel.filters.TransactionCreated(address);

    const events = await this.kernel.queryFilter(filter);

    return Promise.all(
      events.map(async (event) => {
        const txId = event.args?.txId;
        return await this.getTransaction(txId);
      })
    );
  }

  // Subscribe to all kernel events
  onTransactionCreated(
    callback: (tx: Transaction) => void
  ): () => void {
    const filter = this.kernel.filters.TransactionCreated();

    const listener = async (
      provider: string,
      requester: string,
      amount: ethers.BigNumber,
      event: ethers.Event
    ) => {
      const txId = event.args?.txId;
      const tx = await this.getTransaction(txId);
      callback(tx);
    };

    this.kernel.on(filter, listener);
    return () => this.kernel.off(filter, listener);
  }

  onStateChanged(
    callback: (txId: string, from: State, to: State) => void
  ): () => void {
    const filter = this.kernel.filters.StateTransitioned();

    const listener = (
      txId: string,
      from: number,
      to: number
    ) => {
      callback(txId, from as State, to as State);
    };

    this.kernel.on(filter, listener);
    return () => this.kernel.off(filter, listener);
  }

  private async getTransaction(txId: string): Promise<Transaction> {
    const txData = await this.kernel.transactions(txId);
    // ... convert to Transaction object
    return txData;
  }
}
```

---

### 2.2. Network Configuration

```typescript
interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  blockExplorer: string;
  contracts: {
    actpKernel: string;
    escrowVault: string;
    usdc: string;
  };
  gasSettings: {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  };
}

const BASE_SEPOLIA: NetworkConfig = {
  name: 'Base Sepolia',
  chainId: 84532,
  rpcUrl: 'https://sepolia.base.org',
  blockExplorer: 'https://sepolia.basescan.org',
  contracts: {
    actpKernel: '0x...', // Set after deployment
    escrowVault: '0x...',
    usdc: '0x...'        // MockUSDC for testnet
  },
  gasSettings: {
    maxFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei')
  }
};

const BASE_MAINNET: NetworkConfig = {
  name: 'Base Mainnet',
  chainId: 8453,
  rpcUrl: 'https://mainnet.base.org',
  blockExplorer: 'https://basescan.org',
  contracts: {
    actpKernel: '0x...', // TBD
    escrowVault: '0x...',
    usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' // Official USDC
  },
  gasSettings: {
    maxFeePerGas: ethers.utils.parseUnits('0.5', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits('0.1', 'gwei')
  }
};

export const NETWORKS: Record<string, NetworkConfig> = {
  'base-sepolia': BASE_SEPOLIA,
  'base-mainnet': BASE_MAINNET
};
```

---

### 2.3. Error Handling

```typescript
// Base ACTP Error
export class ACTPError extends Error {
  constructor(
    message: string,
    public code: string,
    public txHash?: string,
    public details?: any
  ) {
    super(message);
    this.name = 'ACTPError';
  }
}

// Transaction Errors
export class InsufficientFundsError extends ACTPError {
  constructor(required: bigint, available: bigint) {
    super(
      `Insufficient funds: need ${ethers.utils.formatUnits(required, 6)} USDC, ` +
      `have ${ethers.utils.formatUnits(available, 6)} USDC`,
      'INSUFFICIENT_FUNDS',
      undefined,
      { required, available }
    );
  }
}

export class TransactionNotFoundError extends ACTPError {
  constructor(txId: string) {
    super(
      `Transaction ${txId} not found`,
      'TRANSACTION_NOT_FOUND',
      undefined,
      { txId }
    );
  }
}

export class DeadlineExpiredError extends ACTPError {
  constructor(txId: string, deadline: number) {
    super(
      `Transaction ${txId} deadline expired at ${new Date(deadline * 1000).toISOString()}`,
      'DEADLINE_EXPIRED',
      undefined,
      { txId, deadline }
    );
  }
}

// State Machine Errors
export class InvalidStateTransitionError extends ACTPError {
  constructor(from: State, to: State) {
    const validTransitions = StateMachine.getNextValidStates(from)
      .map(s => State[s])
      .join(', ');

    super(
      `Invalid state transition: ${State[from]} → ${State[to]}. ` +
      `Valid transitions: ${validTransitions}`,
      'INVALID_STATE_TRANSITION',
      undefined,
      { from, to, validTransitions }
    );
  }
}

// Signature Errors
export class SignatureVerificationError extends ACTPError {
  constructor(expectedSigner: string, recoveredSigner: string) {
    super(
      `Signature verification failed. Expected ${expectedSigner}, got ${recoveredSigner}`,
      'SIGNATURE_VERIFICATION_FAILED',
      undefined,
      { expectedSigner, recoveredSigner }
    );
  }
}

// Blockchain Errors
export class TransactionRevertedError extends ACTPError {
  constructor(txHash: string, reason?: string) {
    super(
      `Transaction reverted: ${reason || 'Unknown reason'}`,
      'TRANSACTION_REVERTED',
      txHash,
      { reason }
    );
  }
}

export class NetworkError extends ACTPError {
  constructor(network: string, message: string) {
    super(
      `Network error on ${network}: ${message}`,
      'NETWORK_ERROR',
      undefined,
      { network }
    );
  }
}
```

---

### 2.4. Complete Usage Example (Protocol SDK)

```typescript
import { ACTPClient, State } from '@agirails/sdk';

async function completeTransactionFlow() {
  // 1. Initialize client
  const client = new ACTPClient({
    network: 'base-sepolia',
    privateKey: process.env.PROVIDER_PRIVATE_KEY
  });

  const requesterAddress = '0x1234...'; // Requester's address
  const providerAddress = await client.getAddress();

  // 2. Create transaction
  console.log('Creating transaction...');
  const txId = await client.kernel.createTransaction({
    provider: providerAddress,
    requester: requesterAddress,
    amount: ethers.utils.parseUnits('100', 6), // 100 USDC
    deadline: Math.floor(Date.now() / 1000) + 86400, // 24 hours
    disputeWindow: 3600, // 1 hour dispute window
    metadata: ethers.utils.formatBytes32String('translation-job-001')
  });

  console.log(`Transaction created: ${txId}`);

  // 3. Monitor transaction state
  const unsubscribe = await client.events.watchTransaction(
    txId,
    (newState) => {
      console.log(`State changed to: ${State[newState]}`);
    }
  );

  // 4. Create escrow (requester does this)
  console.log('Creating escrow...');
  const escrowId = await client.escrow.createEscrow({
    kernelAddress: client.kernel.address,
    txId,
    token: NETWORKS['base-sepolia'].contracts.usdc,
    amount: ethers.utils.parseUnits('100', 6),
    beneficiary: providerAddress
  });

  console.log(`Escrow created: ${escrowId}`);

  // 5. Link escrow to transaction
  await client.kernel.linkEscrow(
    txId,
    client.escrow.address,
    escrowId
  );

  // 6. Transition to IN_PROGRESS
  await client.kernel.transitionState(txId, State.IN_PROGRESS);

  // 7. Provider delivers work
  console.log('Generating delivery proof...');
  const deliverable = 'Translated content here...';
  const proof = client.proofGenerator.generateDeliveryProof({
    txId,
    deliverable,
    metadata: { language: 'es', wordCount: 1000 }
  });

  // 8. Transition to DELIVERED with proof
  const proofData = client.proofGenerator.encodeProof(proof);
  await client.kernel.transitionState(txId, State.DELIVERED, proofData);

  // 9. Wait for settlement
  await client.events.waitForState(txId, State.SETTLED, 120000); // 2 min timeout

  console.log('Transaction settled successfully!');

  // 10. Cleanup
  unsubscribe();

  // 11. Get final transaction state
  const finalTx = await client.kernel.getTransaction(txId);
  console.log('Final transaction:', finalTx);
}

// Run
completeTransactionFlow().catch(console.error);
```

---

## 3. Platform SDK (Future) — Post-MVP

**Target:** Post-testnet, Q2 2026  
**Goal:** High-level API for AGIRAILS managed platform services

### 3.1. Vision (From Original Spec)

```typescript
import { AGIRAILS, AgentTier } from '@agirails/sdk';

// Platform SDK: Managed services
const client = new AGIRAILS({
  apiKey: process.env.AGIRAILS_API_KEY,
  network: 'base-sepolia'
});

// High-level agent management
const agent = await client.agents.register({
  name: 'TranslationBot',
  tier: AgentTier.SILVER,
  capabilities: [{
    type: 'translation',
    languages: ['en', 'es', 'fr']
  }]
});

// Discovery API
const providers = await client.discovery.search({
  capability: 'translation',
  minReputation: 700
});

// Managed transactions
const tx = await client.transactions.create({
  buyerDid: agent.did,
  sellerDid: providers[0].did,
  amount: 50.00
});

// Real-time events
client.events.on('transaction.completed', (tx) => {
  console.log(`Transaction ${tx.id} completed!`);
});
```

**Implementation Note:** Platform SDK is a **wrapper** around Protocol SDK + AGIRAILS Platform API. Details deferred to post-MVP specification.

---

## 4. AIP Message Schemas (Reference)

**Source:** Yellow Paper §4-10

### 4.1. AIP-2: Quote Request/Response

```typescript
// quote.request (Yellow Paper §6.2.1)
interface QuoteRequest extends ACTPMessage {
  type: 'quote.request';
  serviceRequest: {
    capabilityType: string;
    parameters: Record<string, any>;
    deliveryRequirements: {
      deadline: string;
      maxDeliveryTime: string;
    };
  };
  budgetConstraints: {
    maxPrice: string;
    currency: 'USDC';
  };
}

// quote.response (Yellow Paper §6.2.2)
interface QuoteResponse extends ACTPMessage {
  type: 'quote.response';
  inResponseTo: string; // Request nonce
  quoteId: string;
  pricing: {
    totalPrice: string;
    currency: 'USDC';
    breakdown: Array<{item: string; amount: string}>;
    platformFee: string;
  };
  sla: {
    successRateGuarantee: number;
    refundPolicy: string;
  };
}
```

### 4.2. AIP-4: Delivery Proof

```typescript
// delivery.proof (Yellow Paper §8.2)
interface DeliveryProof extends ACTPMessage {
  type: 'delivery.proof';
  txId: string;
  contentHash: string;
  deliveryUrl?: string; // Optional: IPFS/Arweave link
  metadata: {
    size: number;
    mimeType: string;
    [key: string]: any;
  };
}
```

**Full AIP schemas:** See Yellow Paper §4-10 for complete specifications.

---

## 5. Implementation Roadmap

### Phase 1: Protocol SDK (Weeks 2-3)

```
Week 2:
├─ Setup TypeScript package structure
├─ Implement ACTPClient (entry point)
├─ Implement ACTPKernel wrapper
├─ Implement StateMachine
├─ Write unit tests (>80% coverage)
└─ Deploy to Base Sepolia testnet

Week 3:
├─ Implement EscrowVault wrapper
├─ Implement MessageSigner
├─ Implement ProofGenerator
├─ Implement EventMonitor
├─ Integration tests on testnet
└─ Publish v0.1.0-beta to npm
```

### Phase 2: n8n Integration (Week 4)

```
Week 4:
├─ Create n8n-nodes-actp package
├─ Build custom ACTP node (uses Protocol SDK)
├─ Visual workflow examples
├─ Tutorial video
└─ Community node submission
```

### Phase 3: Platform SDK (Q2 2026)

```
Post-MVP:
├─ Build AGIRAILS Platform API
├─ Implement Platform SDK wrapper
├─ Add managed wallet services
├─ Add discovery API
├─ Full Python SDK
```

---

## 6. Testing Strategy

### 6.1. Unit Tests

```typescript
// Example: StateMachine tests
describe('StateMachine', () => {
  it('should allow INITIATED → QUOTED transition', () => {
    expect(StateMachine.isValidTransition(
      State.INITIATED,
      State.QUOTED
    )).toBe(true);
  });

  it('should reject INITIATED → SETTLED transition', () => {
    expect(StateMachine.isValidTransition(
      State.INITIATED,
      State.SETTLED
    )).toBe(false);
  });

  it('should identify terminal states', () => {
    expect(StateMachine.isTerminalState(State.SETTLED)).toBe(true);
    expect(StateMachine.isTerminalState(State.IN_PROGRESS)).toBe(false);
  });
});
```

### 6.2. Integration Tests (Testnet)

```typescript
// Example: Full transaction flow test
describe('ACTPKernel Integration', () => {
  let client: ACTPClient;

  beforeAll(async () => {
    client = new ACTPClient({
      network: 'base-sepolia',
      privateKey: process.env.TEST_PRIVATE_KEY
    });
  });

  it('should complete full transaction lifecycle', async () => {
    // Create transaction
    const txId = await client.kernel.createTransaction({
      provider: PROVIDER_ADDRESS,
      requester: REQUESTER_ADDRESS,
      amount: ethers.utils.parseUnits('10', 6),
      deadline: nowPlus24Hours(),
      disputeWindow: 3600
    });

    // Verify transaction state
    const tx = await client.kernel.getTransaction(txId);
    expect(tx.state).toBe(State.INITIATED);

    // ... test full lifecycle
  }, 60000); // 60s timeout
});
```

### 6.3. Test Coverage Requirements

- **Unit tests:** >80% coverage
- **Integration tests:** All critical paths (create → settle, create → dispute)
- **E2E tests:** Complete user flows (provider + requester interaction)
- **Security tests:** Signature verification, unauthorized access

---

## 7. Documentation Structure

```
docs/
├── README.md              # Quick start
├── getting-started.md     # Installation & setup
├── protocol-sdk/
│   ├── ACTPClient.md      # Client API reference
│   ├── ACTPKernel.md      # Kernel methods
│   ├── EscrowVault.md     # Escrow methods
│   ├── StateMachine.md    # State transitions
│   └── examples/          # Code examples
├── platform-sdk/          # Future: Platform API docs
├── aip-schemas/           # AIP message formats
└── troubleshooting.md     # Common issues
```

---

## 8. Dependencies

### 8.1. Core Dependencies

```json
{
  "dependencies": {
    "ethers": "^5.7.2",
    "typescript": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "@openzeppelin/contracts": "^4.9.0"
  }
}
```

### 8.2. Optional Dependencies

```json
{
  "peerDependencies": {
    "@ethereum-attestation-service/eas-sdk": "^1.0.0",
    "ipfs-http-client": "^60.0.0"
  }
}
```

---

## 9. Security Considerations

### 9.1. Private Key Management

**DO:**
- ✅ Store private keys in environment variables
- ✅ Use hardware wallets for production
- ✅ Never log private keys

**DON'T:**
- ❌ Hardcode private keys in source code
- ❌ Commit `.env` files to Git
- ❌ Share private keys over insecure channels

### 9.2. Gas Management

```typescript
// Always estimate gas before sending
const estimatedGas = await client.kernel.contract.estimateGas.createTransaction(...);
const gasLimit = estimatedGas.mul(120).div(100); // 20% buffer

// Set gas price limits
const maxFeePerGas = ethers.utils.parseUnits('5', 'gwei'); // Max 5 gwei
```

### 9.3. Input Validation

```typescript
// Validate addresses
function validateAddress(address: string): void {
  if (!ethers.utils.isAddress(address)) {
    throw new Error(`Invalid address: ${address}`);
  }
}

// Validate amounts
function validateAmount(amount: bigint): void {
  if (amount <= 0n) {
    throw new Error('Amount must be greater than 0');
  }
}

// Validate deadlines
function validateDeadline(deadline: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (deadline <= now) {
    throw new Error('Deadline must be in the future');
  }
}
```

---

## 10. Version History

| Version | Date | Changes |
|---------|------|---------|
| **1.0** | Nov 15, 2025 | Initial specification: Protocol SDK (MVP) + Platform SDK (Future) |

---

## 11. Appendix: Quick Reference

### 11.1. State Machine Cheat Sheet

```
INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED
              ↓          ↓            ↓            ↓
          CANCELLED  CANCELLED    DISPUTED    DISPUTED → SETTLED/CANCELLED
```

### 11.2. Common Operations

```typescript
// Create transaction
const txId = await client.kernel.createTransaction({...});

// Transition state
await client.kernel.transitionState(txId, State.DELIVERED);

// Watch transaction
await client.events.watchTransaction(txId, (state) => {...});

// Get transaction
const tx = await client.kernel.getTransaction(txId);

// Release escrow
await client.kernel.releaseEscrow(txId);
```

### 11.3. Gas Estimates

| Operation | Estimated Gas | Cost @ 1 gwei |
|-----------|---------------|---------------|
| createTransaction | ~150K | ~$0.001 |
| transitionState | ~100K | ~$0.0007 |
| linkEscrow | ~80K | ~$0.0005 |
| releaseEscrow | ~200K | ~$0.0014 |
| raiseDispute | ~120K | ~$0.0008 |

---

**End of Specification v1.0**
