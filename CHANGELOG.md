# Changelog

All notable changes to the AGIRAILS TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Runtime validation for zero contract addresses - SDK now throws helpful error if contracts not yet deployed
- Validation function `validateNetworkConfig()` in `src/config/networks.ts`

### Fixed
- Zero address validation prevents SDK initialization with undeployed contracts

## [0.1.0-beta.1] - 2025-11-19

### Added
- Initial beta release for Base Sepolia testnet
- Core SDK modules:
  - `ACTPClient` - Factory pattern for SDK initialization
  - `Kernel` - Transaction lifecycle management (create, transition states, settlement)
  - `Escrow` - Fund management (create escrow, link to transactions, release)
  - `Events` - Real-time blockchain event monitoring
  - `Messages` - EIP-712 message signing for off-chain communication
  - `Proofs` - Content hashing and delivery proof generation
  - `EAS` - Ethereum Attestation Service integration for reputation
- Builders:
  - `DeliveryProofBuilder` - Construct delivery proofs with evidence
  - `QuoteBuilder` - Create price quotes following AIP-2 format
  - `RequestBuilder` - Build transaction requests following AIP-1 format
- Utilities:
  - IPFS client integration
  - Nonce management for concurrent transactions
  - JSON canonicalization for proof-of-delivery
  - Input validation helpers
- Network configurations:
  - Base Sepolia testnet (chainId: 84532)
  - Base Mainnet (chainId: 8453) - placeholder addresses
- Comprehensive test suite:
  - 348 Jest unit tests (100% passing)
  - Integration tests with Hardhat local network
  - Test coverage: 78.44% (exceeds 70% minimum target)

### Security
- USDC approval pattern correctly implemented (2-step: reset to 0, then approve)
- Gas estimation with dynamic buffers (15-30% based on operation complexity)
- Nonce tracking to prevent transaction conflicts
- Input validation on all public API methods
- SafeERC20 patterns for token interactions

### Known Limitations
- Base Sepolia contract addresses are placeholder zeros (update required post-deployment)
- Base Mainnet addresses are placeholders (mainnet launch TBD)
- EAS attestation schemas not yet deployed (reputation features limited)
- IPFS integration requires separate IPFS node (optional dependency)

### Dependencies
- ethers.js v5.7.2
- @ethereum-attestation-service/eas-sdk v2.5.0
- ipfs-http-client v60.0.1 (optional)

### Developer Notes
**IMPORTANT**: Before using this SDK:
1. Deploy ACTPKernel, EscrowVault, and USDC contracts to your network
2. Update `src/config/networks.ts` with deployed addresses
3. Rebuild: `npm run build`
4. Test with small amounts first ($1-10 USDC recommended)

---

## Release Notes Format

### Version Types
- **MAJOR** (X.0.0): Incompatible API changes
- **MINOR** (0.X.0): Backwards-compatible new features
- **PATCH** (0.0.X): Backwards-compatible bug fixes
- **BETA** (0.1.0-beta.X): Pre-release testing versions

### Change Categories
- **Added**: New features
- **Changed**: Changes in existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Security improvements or vulnerability fixes

---

## Migration Guides

### Migrating from Development Version to 0.1.0-beta.1

No migration needed - this is the first versioned release.

**Post-Deployment Update Required**:
When contracts are deployed to Base Sepolia, you MUST update addresses:

```typescript
// src/config/networks.ts
export const BASE_SEPOLIA: NetworkConfig = {
  // ...
  contracts: {
    actpKernel: '0x[DEPLOYED_KERNEL_ADDRESS]',      // Update this
    escrowVault: '0x[DEPLOYED_ESCROW_ADDRESS]',     // Update this
    usdc: '0x[DEPLOYED_MOCK_USDC_ADDRESS]'          // Update this
  }
};
```

Then rebuild: `npm run build`

---

## Unreleased Changes

See [GitHub Releases](https://github.com/agirails/agirails/releases) for all releases.

---

## Support

- Documentation: `Testnet/sdk/README.md`
- Issues: [GitHub Issues](https://github.com/agirails/agirails/issues)
- Email: developers@agirails.io
