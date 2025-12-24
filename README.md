# @agirails/sdk

TypeScript SDK for the **ACTP (Agent Commerce Transaction Protocol)** - enabling AI agents to transact, escrow funds, and settle payments autonomously.

## Installation

```bash
npm install @agirails/sdk
```

## Quick Start

### 1. Create a Transaction (Requester)

```typescript
import { ACTPClient } from '@agirails/sdk';
import { parseUnits } from 'ethers';

const client = await ACTPClient.create({
  network: 'base-sepolia',
  privateKey: process.env.PRIVATE_KEY
});

// Create transaction with escrow
const txId = await client.kernel.createTransaction({
  provider: '0xProviderAddress...',
  amount: parseUnits('10', 6), // 10 USDC
  serviceRef: 'ipfs://Qm...',  // Service specification
  deadline: Math.floor(Date.now() / 1000) + 86400 // 24h
});

// Fund the escrow
await client.escrow.lockFunds(txId, parseUnits('10', 6));
```

### 2. Accept & Deliver (Provider)

```typescript
const client = await ACTPClient.create({
  network: 'base-sepolia',
  privateKey: process.env.PROVIDER_KEY
});

// Deliver result with proof
await client.kernel.transitionState(txId, 'DELIVERED');
await client.kernel.anchorAttestation(txId, attestationUID);
```

### 3. Release Payment (Requester)

```typescript
// After verifying delivery, release funds
await client.escrow.releaseFunds(txId);
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

Test without blockchain:

```typescript
import { ACTPClient } from '@agirails/sdk';

const client = await ACTPClient.create({
  mode: 'mock'  // No blockchain, no gas fees
});

// Full ACTP flow works identically
const txId = await client.kernel.createTransaction({...});
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

## API Reference

### ACTPClient

```typescript
// Create client
const client = await ACTPClient.create(options);

// Modules
client.kernel    // Transaction lifecycle
client.escrow    // Fund management
client.events    // Event monitoring
client.messages  // EIP-712 signing
```

### Kernel Methods

```typescript
kernel.createTransaction(params)     // Create new transaction
kernel.transitionState(txId, state)  // Change state
kernel.anchorAttestation(txId, uid)  // Attach EAS proof
kernel.getTransaction(txId)          // Get transaction details
```

### Escrow Methods

```typescript
escrow.lockFunds(txId, amount)       // Lock USDC in escrow
escrow.releaseFunds(txId)            // Release to provider
escrow.refund(txId)                  // Refund to requester
escrow.getBalance(txId)              // Check locked amount
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

MIT
