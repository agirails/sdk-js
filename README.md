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

## Known Limitations (V1)

⚠️ **Important**: This is a V1 release with known limitations. Please review before production use.

### Network Resilience
- **No automatic retry** - Manual retry required for network failures
- **No timeout handling** - `tx.wait()` may hang on RPC issues
- **Single RPC dependency** - No automatic failover

### State Transitions
- **TOCTOU race condition** - State may change between SDK check and contract execution
- **Contract provides final validation** - SDK-side checks are advisory only

### Attestation Verification
- **Revocation race window** - Attestation can be revoked between verify and settle
- **Use `releaseEscrowWithVerification()`** - Minimizes race window

See **[KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md)** for detailed explanations, workarounds, and roadmap.

**V1.1 Planned** (2-4 weeks): Automatic retry, timeout handling, nonce management
**V2.0 Planned** (3-6 months): On-chain attestation validation, TOCTOU mitigation, multi-provider fallback

---

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

# Unit tests (Jest - fast, no network)
npm test

# Integration tests (Hardhat - requires Base Sepolia RPC)
npm run test:integration

# Lint
npm run lint
```

### Integration Testing

Integration tests run against **deployed contracts** on Base Sepolia testnet:

**Prerequisites:**
1. Create `.env` file:
   ```bash
   BASE_SEPOLIA_RPC=https://sepolia.base.org  # or your Alchemy URL
   PRIVATE_KEY=0x...  # Account with Base Sepolia ETH for gas
   ```

2. Get testnet ETH:
   - [Base Sepolia Faucet](https://www.coinbase.com/faucets/base-ethereum-goerli-faucet)

**Run tests:**
```bash
npx hardhat test --network base-sepolia
```

Tests will:
- ✅ Connect to deployed ACTPKernel, EscrowVault, MockUSDC
- ✅ Mint test USDC (MockUSDC has open minting on testnet)
- ✅ Run full transaction lifecycle (INITIATED → SETTLED)
- ✅ Verify escrow release and fund transfers

## Contract Addresses

### Base Sepolia (Testnet) ✅ Deployed & Verified
- **ACTPKernel:** `0x7Cb7867C3D2BAd7AE4ee236B5FddC0AFEc633370` ([view](https://sepolia.basescan.org/address/0x7Cb7867C3D2BAd7AE4ee236B5FddC0AFEc633370#code))
- **EscrowVault:** `0x41D45491451C5AE318fdb4f0Bc224d628571FC0F` ([view](https://sepolia.basescan.org/address/0x41D45491451C5AE318fdb4f0Bc224d628571FC0F#code))
- **MockUSDC:** `0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb` ([view](https://sepolia.basescan.org/address/0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb#code))

*Deployed: 2025-11-22 21:14 UTC | Latest deployment from Foundry broadcast | Matches src/config/networks.ts*

### Base Mainnet (Production)
- **ACTPKernel:** TBD *(pending mainnet deployment)*
- **EscrowVault:** TBD *(pending mainnet deployment)*
- **USDC:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (official USDC on Base)

## License

Apache-2.0

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) *(coming soon)*

## Support

- **Email:** developers@agirails.io
- **GitHub:** [github.com/agirails/actp-sdk-typescript](https://github.com/agirails/actp-sdk-typescript)
- **Discord:** [discord.gg/agirails](https://discord.gg/agirails)

