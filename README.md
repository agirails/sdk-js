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

## V1 Limitations

⚠️ **Important**: ACTP SDK v2.0.0-beta is designed for **Base Sepolia testnet** and controlled partner usage. The following limitations apply:

### 1. Attestation Validation is SDK-Enforced, Not Protocol-Enforced

The V1 ACTPKernel accepts attestation UIDs without on-chain validation. All verification (existence, schema, txId, revocation, expiry) is performed by SDK helpers like `releaseEscrowWithVerification()`.

**Security checks performed by SDK:**
- Attestation exists and UID matches
- Schema UID matches canonical delivery schema (`0x1b0e...ffce`)
- txId in attestation matches expected transaction
- Attestation is not revoked (`revocationTime === 0`)
- Attestation has not expired

**Integrators who bypass the SDK must implement equivalent verification logic.**

### 2. Multiple Attestations Per Transaction Are Possible

EAS does not enforce uniqueness - multiple attestations can exist for the same `txId`. The SDK uses the **first valid (non-revoked) attestation** provided. This policy is testnet-appropriate; V2 will enforce uniqueness at the protocol level.

### 3. This SDK is Not For Unrestricted Mainnet Usage

V2 will move critical verification on-chain. Until then, use only on Base Sepolia testnet with testnet USDC.

### Additional Limitations

| Area | Limitation | Workaround |
|------|------------|------------|
| Network Resilience | No automatic retry | Manual retry required |
| Timeout Handling | `tx.wait()` may hang | Set custom timeout |
| State Transitions | TOCTOU race condition | Contract provides final validation |
| Revocation Window | Attestation can be revoked between verify and settle | Use `releaseEscrowWithVerification()` |

See **[KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md)** for detailed explanations and roadmap.

For full details, see the [EAS V1 Scope Governance Document](../../Docs/Governance/).

**V2.0 Planned**: On-chain attestation validation, uniqueness enforcement, multi-provider fallback

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
- **ACTPKernel:** `0x6aDB650e185b0ee77981AC5279271f0Fa6CFe7ba` ([view](https://sepolia.basescan.org/address/0x6aDB650e185b0ee77981AC5279271f0Fa6CFe7ba#code))
- **EscrowVault:** `0x921edE340770db5DB6059B5B866be987d1b7311F` ([view](https://sepolia.basescan.org/address/0x921edE340770db5DB6059B5B866be987d1b7311F#code))
- **MockUSDC:** `0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb` ([view](https://sepolia.basescan.org/address/0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb#code))
- **EAS Contract:** `0x4200000000000000000000000000000000000021` (Base native)
- **EAS Schema Registry:** `0x4200000000000000000000000000000000000020` (Base native)
- **Delivery Schema UID:** `0x1b0ebdf0bd20c28ec9d5362571ce8715a55f46e81c3de2f9b0d8e1b95fb5ffce`

*Redeployed: 2025-11-25 | Fixed auto-transition in linkEscrow, optimizer-runs 200 | Matches src/config/networks.ts*

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

