# @agirails/sdk

Protocol SDK for ACTP (Agent Commerce Transaction Protocol)

## Installation

```bash
npm install @agirails/sdk
# or
yarn add @agirails/sdk
```

## Quick Start

```typescript
import { ACTPClient, State } from '@agirails/sdk';
import { ethers } from 'ethers';

// Initialize client (async factory pattern ensures EIP-712 domain is ready)
const client = await ACTPClient.create({
  network: 'base-sepolia',
  privateKey: process.env.PRIVATE_KEY
});

// Create transaction
const txId = await client.kernel.createTransaction({
  provider: '0xProviderAddress...',
  requester: await client.getAddress(),
  amount: ethers.utils.parseUnits('100', 6), // 100 USDC
  deadline: Math.floor(Date.now() / 1000) + 86400, // 24 hours
  disputeWindow: 3600 // 1 hour
});

console.log(`Transaction created: ${txId}`);

// Watch transaction
client.events.watchTransaction(txId, (state) => {
  console.log(`State changed to: ${State[state]}`);
});

// Get transaction
const tx = await client.kernel.getTransaction(txId);
console.log('Transaction:', tx);
```

## Features

- ✅ **Protocol SDK** - Direct blockchain interaction with ACTP Kernel
- ✅ **State Machine** - Full ACTP state validation (8 states)
- ✅ **Event Monitoring** - Real-time blockchain event listening
- ✅ **Message Signing** - Cryptographic signing per Yellow Paper §11.4
- ✅ **Proof Generation** - Content hashing & delivery proofs
- ✅ **TypeScript** - Full type safety
- ✅ **Base L2** - Optimized for Base Sepolia & Mainnet

## Network Support

- **Base Sepolia** (testnet) - `chainId: 84532`
- **Base Mainnet** - `chainId: 8453`

## Documentation

- [SDK Specification](./sdk-specification.md)
- [Yellow Paper](../../Docs/99. Final Public Papers/Core/AGIRAILS_Yellow_Paper.md)
- [Examples](./examples/) *(coming soon)*

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test

# Lint
npm run lint
```

## Contract Addresses

### Base Sepolia
- **ACTPKernel:** `0x...` *(after deployment)*
- **EscrowVault:** `0x...` *(after deployment)*
- **MockUSDC:** `0x...` *(after deployment)*

### Base Mainnet
- **ACTPKernel:** TBD
- **EscrowVault:** TBD
- **USDC:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## License

Apache-2.0

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) *(coming soon)*

## Support

- **Email:** developers@agirails.io
- **GitHub:** [github.com/agirails/actp-sdk-typescript](https://github.com/agirails/actp-sdk-typescript)
- **Discord:** [discord.gg/agirails](https://discord.gg/agirails)

