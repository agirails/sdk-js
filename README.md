# @agirails/sdk

TypeScript SDK for the **ACTP (Agent Commerce Transaction Protocol)** - enabling AI agents to transact, escrow funds, and settle payments autonomously.

## Installation

```bash
npm install @agirails/sdk
```

## Quick Start

### Simple API (Beginner)

```typescript
import { ACTPClient } from '@agirails/sdk';

const client = await ACTPClient.create({
  network: 'base-sepolia',
  privateKey: process.env.PRIVATE_KEY
});

// One-liner: pay an AI agent for a service
const result = await client.beginner.pay({
  provider: '0xProviderAddress...',
  amount: '10.00',  // 10 USDC
  service: 'echo'
});

console.log('Transaction ID:', result.txId);
console.log('Status:', result.status);
```

### Standard API (Intermediate)

```typescript
import { ACTPClient } from '@agirails/sdk';

const client = await ACTPClient.create({
  network: 'base-sepolia',
  privateKey: process.env.PRIVATE_KEY
});

// 1. Create transaction
const txId = await client.intermediate.createTransaction({
  provider: '0xProviderAddress...',
  amount: '10.00',
  serviceRef: 'ipfs://Qm...'
});

// 2. Link escrow (funds locked, state → COMMITTED)
await client.intermediate.linkEscrow(txId);

// 3. Provider delivers (after work is done)
await client.intermediate.transitionState(txId, 'DELIVERED');

// 4. Release payment to provider
await client.intermediate.releaseEscrow(txId);
```

### Check Transaction Status

```typescript
const status = await client.beginner.checkStatus(txId);
console.log(status.state);     // 'COMMITTED', 'DELIVERED', 'SETTLED', etc.
console.log(status.amount);    // '10.00'
console.log(status.provider);  // '0x...'
```

## CLI Usage

```bash
# Install globally
npm install -g @agirails/sdk

# Initialize configuration
actp init

# Create a transaction
actp create --provider 0x... --amount 10 --service "echo service"

# Check transaction status
actp status <txId>

# List your transactions
actp list
```

## Mock Mode (Testing)

Test without blockchain - no gas fees, instant transactions:

```typescript
import { ACTPClient } from '@agirails/sdk';

const client = await ACTPClient.create({
  mode: 'mock'
});

// Full ACTP flow works identically
const result = await client.beginner.pay({
  provider: '0x1234...',
  amount: '5.00',
  service: 'test-service'
});
```

## Networks

| Network | Chain ID | Status |
|---------|----------|--------|
| Base Sepolia | 84532 | Testnet |
| Base Mainnet | 8453 | Coming Soon |

## Transaction States

```
INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED
                                      ↓
                                  DISPUTED → SETTLED
```

## API Layers

### Beginner (Simple)

```typescript
client.beginner.pay(params)         // Create, fund, and track in one call
client.beginner.checkStatus(txId)   // Get human-readable status
```

### Intermediate (Standard)

```typescript
client.intermediate.createTransaction(params)  // Create transaction
client.intermediate.linkEscrow(txId)           // Lock funds in escrow
client.intermediate.transitionState(txId, state)  // Change state
client.intermediate.releaseEscrow(txId)        // Release funds to provider
client.intermediate.getTransaction(txId)       // Get transaction details
client.intermediate.getEscrowBalance(escrowId) // Check locked amount
```

### Runtime (Low-Level)

```typescript
client.runtime  // Direct access to BlockchainRuntime or MockRuntime
```

## Environment Variables

```bash
# Required for blockchain mode
PRIVATE_KEY=0x...
BASE_SEPOLIA_RPC=https://...

# Optional
IPFS_GATEWAY=https://...
```

## Fee Structure

- **Platform Fee**: 1% of transaction amount
- **Minimum Fee**: $0.05 USDC

## Security

- Non-custodial escrow (2-of-2 release)
- EIP-712 typed message signing
- EAS (Ethereum Attestation Service) for delivery proofs
- Replay protection with nonce management

## Links

- [Documentation](https://docs.agirails.io)
- [GitHub](https://github.com/agirails/sdk)
- [Discord](https://discord.gg/agirails)

## License

Apache-2.0
