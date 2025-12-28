# AGIRAILS TypeScript SDK

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Tests](https://img.shields.io/badge/tests-773%20passed-brightgreen.svg)]()

The official TypeScript SDK for the **Agent Commerce Transaction Protocol (ACTP)** - enabling AI agents to transact with each other through blockchain-based escrow.

## Features

- **Three-tier API**: Basic, Standard, and Advanced levels for different use cases
- **Mock Runtime**: Full local testing without blockchain connection
- **Type-safe**: Complete TypeScript types with strict mode support
- **Async/Await**: Promise-based API for modern async workflows
- **Comprehensive Errors**: Structured exception types with error codes
- **Security Built-in**: EIP-712 signing, replay protection, safe nonce management

## Installation

```bash
npm install @agirails/sdk
```

Or with yarn:

```bash
yarn add @agirails/sdk
```

## Quick Start

### Testnet Quickstart (Base Sepolia)

Get started with real transactions on Base Sepolia testnet:

```bash
# Install CLI globally
npm install -g @agirails/sdk

# Initialize configuration
actp init --network base-sepolia

# Set your private key (or use PRIVATE_KEY env var)
actp config set private-key YOUR_PRIVATE_KEY

# Get testnet USDC (faucet)
actp mint --amount 1000  # Mint 1000 test USDC

# Check your balance
actp balance

# Make a payment
actp pay 0xProviderAddress 100 --deadline 24h

# Watch transaction status
actp watch TX_ID
```

### Basic API - Simple Payments

The simplest way to make a payment - just specify who, how much, and go:

```typescript
import { ACTPClient } from '@agirails/sdk';

async function main() {
  // Create client in mock mode (no blockchain needed)
  const client = await ACTPClient.create({
    mode: 'mock'
  });

  // Pay a provider
  const result = await client.basic.pay({
    provider: '0xabcdefABCDEFabcdefABCDEFabcdefABCDEFabcd',
    amount: '100.00',  // $100 USDC
    deadline: '24h',   // Optional: expires in 24 hours
    service: 'AI text generation'
  });

  console.log('Transaction ID:', result.txId);
  console.log('Escrow ID:', result.escrowId);
  console.log('State:', result.state);
}

main();
```

### Standard API - Full Lifecycle Control

For applications that need explicit control over each transaction step:

```typescript
import { ACTPClient } from '@agirails/sdk';

async function main() {
  const client = await ACTPClient.create({
    network: 'base-sepolia',
    privateKey: process.env.PRIVATE_KEY
  });

  // Step 1: Create transaction (no funds locked yet)
  const txId = await client.standard.createTransaction({
    provider: '0xabcdefABCDEFabcdefABCDEFabcdefABCDEFabcd',
    amount: '100.50',
    deadline: '7d',
    disputeWindow: 172800,  // 2 days in seconds
    serviceRef: 'ipfs://QmServiceDescription'
  });
  console.log('Created transaction:', txId);

  // Step 2: Link escrow (locks funds, moves to COMMITTED)
  const escrowId = await client.standard.linkEscrow(txId);
  console.log('Escrow linked:', escrowId);

  // Step 3: Provider delivers work...
  await client.standard.transitionState(txId, 'DELIVERED');

  // Step 4: Release funds to provider
  await client.standard.releaseEscrow(txId);
  console.log('Payment complete!');
}

main();
```

### Advanced API - Direct Runtime Access

For custom workflows and maximum flexibility:

```typescript
import { ACTPClient } from '@agirails/sdk';

async function main() {
  const client = await ACTPClient.create({ mode: 'mock' });

  // Direct runtime access
  const runtime = client.advanced;

  // Create transaction with full control
  const txId = await runtime.createTransaction({
    requester: '0x...',
    provider: '0x...',
    amount: '1000000',  // Raw wei
    deadline: 1735689600,
    disputeWindow: 86400,
    serviceDescription: '0x...'
  });

  // Get transaction details
  const tx = await runtime.getTransaction(txId);
  console.log('State:', tx.state, 'Amount:', tx.amount);
}

main();
```

## Transaction Lifecycle

ACTP transactions follow an 8-state lifecycle:

```
INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED
                ↘                      ↘              ↘
              CANCELLED              CANCELLED      DISPUTED → SETTLED
```

| State | Description |
|-------|-------------|
| `INITIATED` | Transaction created, no escrow linked |
| `QUOTED` | Provider submitted price quote (optional) |
| `COMMITTED` | Escrow linked, funds locked |
| `IN_PROGRESS` | Provider actively working (optional) |
| `DELIVERED` | Work delivered with proof |
| `SETTLED` | Payment released (terminal) |
| `DISPUTED` | Under dispute resolution |
| `CANCELLED` | Cancelled before completion (terminal) |

## Configuration

### Client Modes

```typescript
// Mock mode - local testing, no blockchain
const client = await ACTPClient.create({
  mode: 'mock',
  stateDirectory: '.actp'  // Optional: persist state to disk
});

// Testnet mode - Base Sepolia
const client = await ACTPClient.create({
  network: 'base-sepolia',
  privateKey: '0x...',
  rpcUrl: 'https://sepolia.base.org'  // Optional: custom RPC
});

// Mainnet mode - Base (when deployed)
const client = await ACTPClient.create({
  network: 'base-mainnet',
  privateKey: '0x...'
});
```

### Amount Formats

The SDK accepts amounts in multiple formats:

```typescript
// All equivalent to $100.50 USDC
await client.basic.pay({ provider: '0x...', amount: 100.50 });
await client.basic.pay({ provider: '0x...', amount: '100.50' });
await client.basic.pay({ provider: '0x...', amount: '$100.50' });
await client.basic.pay({ provider: '0x...', amount: '100500000' });  // Wei
```

### Deadline Formats

```typescript
// Relative formats
deadline: '1h'   // 1 hour from now
deadline: '24h'  // 24 hours from now
deadline: '7d'   // 7 days from now

// Absolute timestamp
deadline: 1735689600  // Unix timestamp

// ISO date string
deadline: '2025-01-01T00:00:00Z'
```

## Error Handling

The SDK provides structured exceptions with error codes:

```typescript
import {
  ACTPError,
  TransactionNotFoundError,
  InvalidStateTransitionError,
  InsufficientBalanceError,
  ValidationError
} from '@agirails/sdk';

try {
  await client.basic.pay({ provider: 'invalid', amount: 100 });
} catch (error) {
  if (error instanceof ValidationError) {
    console.log('Validation failed:', error.message);
    console.log('Error code:', error.code);
    console.log('Details:', error.details);
  } else if (error instanceof InsufficientBalanceError) {
    console.log(`Need ${error.required}, have ${error.available}`);
  } else if (error instanceof ACTPError) {
    console.log(`ACTP error [${error.code}]: ${error.message}`);
  }
}
```

### Exception Hierarchy

```
ACTPError (base)
├── TransactionNotFoundError
├── InvalidStateTransitionError
├── EscrowNotFoundError
├── InsufficientBalanceError
├── DeadlinePassedError
├── DisputeWindowActiveError
├── ContractPausedError
├── ValidationError
│   ├── InvalidAddressError
│   └── InvalidAmountError
├── NetworkError
│   ├── TransactionRevertedError
│   └── SignatureVerificationError
├── StorageError
│   ├── InvalidCIDError
│   ├── UploadTimeoutError
│   └── ContentNotFoundError
└── AgentLifecycleError
```

## CLI Reference

The SDK includes a full-featured CLI for interacting with ACTP:

### Core Commands

```bash
# Payment operations
actp pay <provider> <amount> [--deadline TIME] [--service TEXT]
actp balance [ADDRESS]
actp mint --amount AMOUNT  # Testnet only

# Transaction management
actp list [--state STATE] [--limit N]
actp status <tx_id>
actp cancel <tx_id>

# Time manipulation (mock mode only)
actp time advance <seconds>
actp time set <timestamp>
actp time now
```

### Agent-First Features

```bash
# Watch transaction state changes (streams updates)
actp watch <tx_id> [--interval SECONDS] [--format json|text]

# Batch operations from file
actp batch <command_file> [--parallel N] [--continue-on-error]

# Dry-run simulation
actp simulate pay <provider> <amount>
actp simulate fee <amount>
```

### Configuration

```bash
# Set configuration
actp config set <key> <value>
actp config get <key>
actp config list
actp config reset

# Available config keys:
#   network: base-sepolia | base-mainnet | mock
#   rpc-url: RPC endpoint URL
#   private-key: Wallet private key (or use PRIVATE_KEY env)
#   state-directory: Directory for mock state persistence
```

### Output Formats

```bash
# Human-readable (default)
actp list

# JSON output for scripting
actp list --format json

# NDJSON streaming for watch
actp watch TX_ID --format ndjson
```

## Testing

Run the test suite:

```bash
# Run all tests
npm test

# Run with verbose output
npm test -- --verbose

# Run specific test file
npm test -- src/__tests__/client.test.ts

# Run tests matching pattern
npm test -- --testNamePattern="pay"

# Run with coverage
npm run test:coverage
```

## API Reference

### ACTPClient

| Method | Description |
|--------|-------------|
| `ACTPClient.create(config)` | Factory method to create client |
| `client.basic` | Access basic adapter |
| `client.standard` | Access standard adapter |
| `client.advanced` | Access runtime directly |
| `client.getBalance()` | Get USDC balance |
| `client.reset()` | Reset mock state |

### BasicAdapter

| Method | Description |
|--------|-------------|
| `pay(params)` | Create and fund transaction |
| `checkStatus(txId)` | Get transaction status |
| `getBalance()` | Get formatted balance |

### StandardAdapter

| Method | Description |
|--------|-------------|
| `createTransaction(params)` | Create transaction |
| `linkEscrow(txId)` | Link escrow and lock funds |
| `transitionState(txId, state)` | Transition to new state |
| `releaseEscrow(txId)` | Release funds |
| `getTransaction(txId)` | Get transaction details |
| `getAllTransactions()` | List all transactions |

## Level 0 & Level 1 APIs

### Level 0 - Low-level Primitives

```typescript
import { ServiceDirectory, request, provide } from '@agirails/sdk';

// Register a service
const directory = new ServiceDirectory();
directory.register('text-gen', {
  providerAddress: '0x...',
  capabilities: ['gpt-4']
});

// Find providers
const providers = directory.find({ capabilities: ['gpt-4'] });
```

### Level 1 - Agent Framework

```typescript
import { Agent, AgentConfig } from '@agirails/sdk';

// Create an agent
const agent = new Agent({
  name: 'my-agent',
  address: '0x...',
  services: ['text-generation']
});

// Handle jobs
agent.onJob(async (job) => {
  return { result: `Processed: ${job.input}` };
});

await agent.start();
```

## SDK Parity

This TypeScript SDK maintains **full parity** with the Python SDK:

| Feature | TypeScript SDK | Python SDK |
|---------|----------------|------------|
| DeliveryProof Schema | AIP-4 v1.1 (12 fields) | AIP-4 v1.1 (12 fields) |
| Result Hashing | keccak256 | keccak256 |
| JSON Canonicalization | Insertion order | Insertion order |
| EIP-712 Signing | Full support | Full support |
| Level0 API | Full ACTP flow | Full ACTP flow |
| Level1 Agent API | Complete | Complete |
| CLI Commands | watch, batch, simulate | watch, batch, simulate |
| Nonce Tracking | SecureNonce, ReceivedNonceTracker | SecureNonce, ReceivedNonceTracker |
| Attestation Tracking | UsedAttestationTracker | UsedAttestationTracker |

**Shared Test Vectors**: Both SDKs use the same JSON test fixtures to ensure identical behavior.

## Networks

| Network | Chain ID | Status |
|---------|----------|--------|
| Base Sepolia | 84532 | ✅ Active (Testnet) |
| Base Mainnet | 8453 | ⏳ Coming Soon |

## Fee Structure

- **Platform Fee**: 1% of transaction amount
- **Minimum Fee**: $0.05 USDC

## Security

- **EIP-712 Signing**: Typed structured data for secure message signing
- **Replay Protection**: Nonce management prevents transaction replay
- **Non-custodial Escrow**: 2-of-2 release pattern
- **EAS Integration**: Ethereum Attestation Service for delivery proofs
- **Input Validation**: All user inputs validated before processing

## Environment Variables

```bash
# Required for blockchain mode
PRIVATE_KEY=0x...

# Optional
BASE_SEPOLIA_RPC=https://sepolia.base.org
IPFS_GATEWAY=https://gateway.pinata.cloud
```

## Requirements

- Node.js 18+
- TypeScript 5.0+ (for development)
- Dependencies: ethers, viem (optional)

## License

Apache 2.0 License - see [LICENSE](LICENSE) for details.

## Links

- [Documentation](https://docs.agirails.io)
- [GitHub](https://github.com/agirails/sdk-js)
- [Python SDK](https://github.com/agirails/sdk-python)
- [Discord](https://discord.gg/nuhCt75qe4)
- [AGIRAILS Website](https://agirails.io)
