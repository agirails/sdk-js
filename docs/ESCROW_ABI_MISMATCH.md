# EscrowVault ABI Mismatch - CRITICAL

**Date:** 2024-12-14
**Status:** Unresolved - Requires ABI Update
**Severity:** HIGH - SDK escrow operations will fail on testnet/mainnet

## Summary

The SDK's `EscrowVault.json` ABI does not match the deployed Protocol's `EscrowVault.sol` contract. This means all escrow-related SDK operations will revert when used against the real blockchain.

## Comparison

### SDK's EscrowVault.json (INCORRECT)

```typescript
// createEscrow - WRONG SIGNATURE
createEscrow(kernel, txId, token, amount, beneficiary) → escrowId

// disburse - DOES NOT EXIST IN PROTOCOL
disburse(escrowId, recipients[], amounts[])

// escrows mapping - WRONG STRUCT SHAPE
escrows(escrowId) → {kernel, txId, token, amount, beneficiary, released}
```

### Protocol's EscrowVault.sol (ACTUAL)

```solidity
// IEscrowValidator interface methods
createEscrow(escrowId, requester, provider, amount)  // onlyKernel
verifyEscrow(escrowId, requester, provider, amount) → (isActive, escrowAmount)
payoutToProvider(escrowId, amount) → amountReleased   // onlyKernel
refundToRequester(escrowId, amount) → amountReleased  // onlyKernel
payout(escrowId, recipient, amount) → amountReleased  // onlyKernel
remaining(escrowId) → uint256

// escrows mapping - ACTUAL struct
escrows(escrowId) → {requester, provider, amount, releasedAmount, active}
```

## Impact

### Broken SDK Methods

| SDK Method | SDK Calls | Protocol Has | Result |
|------------|-----------|--------------|--------|
| `releaseEscrow()` | `disburse()` | N/A | **REVERTS** |
| `getEscrow()` | `escrows()` | Different struct | **WRONG DATA** |
| `getEscrowBalance()` | Uses `getEscrow()` | N/A | **WRONG DATA** |

### What Still Works

- `approveToken()` - Uses standard ERC20, works fine
- `getTokenBalance()` - Uses standard ERC20, works fine
- `getTokenAllowance()` - Uses standard ERC20, works fine

## Root Cause

The SDK's ABI was designed for a different escrow architecture:
- SDK expects: Multi-recipient disbursement model with kernel tracking
- Protocol has: Single-recipient payout model with requester/provider roles

## Resolution Options

### Option 1: Update SDK ABI (Recommended)

Update `src/abi/EscrowVault.json` to match the Protocol's actual interface:

```json
[
  {
    "inputs": [
      {"name": "escrowId", "type": "bytes32"},
      {"name": "requester", "type": "address"},
      {"name": "provider", "type": "address"},
      {"name": "amount", "type": "uint256"}
    ],
    "name": "createEscrow",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {"name": "escrowId", "type": "bytes32"},
      {"name": "requester", "type": "address"},
      {"name": "provider", "type": "address"},
      {"name": "amount", "type": "uint256"}
    ],
    "name": "verifyEscrow",
    "outputs": [
      {"name": "isActive", "type": "bool"},
      {"name": "escrowAmount", "type": "uint256"}
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {"name": "escrowId", "type": "bytes32"},
      {"name": "amount", "type": "uint256"}
    ],
    "name": "payoutToProvider",
    "outputs": [{"name": "amountReleased", "type": "uint256"}],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {"name": "escrowId", "type": "bytes32"},
      {"name": "amount", "type": "uint256"}
    ],
    "name": "refundToRequester",
    "outputs": [{"name": "amountReleased", "type": "uint256"}],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {"name": "escrowId", "type": "bytes32"},
      {"name": "recipient", "type": "address"},
      {"name": "amount", "type": "uint256"}
    ],
    "name": "payout",
    "outputs": [{"name": "amountReleased", "type": "uint256"}],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{"name": "escrowId", "type": "bytes32"}],
    "name": "remaining",
    "outputs": [{"name": "", "type": "uint256"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{"name": "escrowId", "type": "bytes32"}],
    "name": "escrows",
    "outputs": [
      {"name": "requester", "type": "address"},
      {"name": "provider", "type": "address"},
      {"name": "amount", "type": "uint256"},
      {"name": "releasedAmount", "type": "uint256"},
      {"name": "active", "type": "bool"}
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      {"indexed": true, "name": "escrowId", "type": "bytes32"},
      {"indexed": true, "name": "requester", "type": "address"},
      {"indexed": true, "name": "provider", "type": "address"},
      {"indexed": false, "name": "amount", "type": "uint256"}
    ],
    "name": "EscrowCreated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {"indexed": true, "name": "escrowId", "type": "bytes32"},
      {"indexed": true, "name": "recipient", "type": "address"},
      {"indexed": false, "name": "amount", "type": "uint256"}
    ],
    "name": "EscrowPayout",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {"indexed": true, "name": "escrowId", "type": "bytes32"},
      {"indexed": false, "name": "totalReleased", "type": "uint256"}
    ],
    "name": "EscrowCompleted",
    "type": "event"
  }
]
```

### Option 2: Update EscrowVault.ts

After updating the ABI, update `src/protocol/EscrowVault.ts`:

1. Remove `releaseEscrow(escrowId, recipients[], amounts[])`
2. Add:
   - `payoutToProvider(escrowId, amount)`
   - `refundToRequester(escrowId, amount)`
   - `payout(escrowId, recipient, amount)`
   - `remaining(escrowId)`
   - `verifyEscrow(escrowId, requester, provider, amount)`
3. Update `getEscrow()` to return correct struct shape

### Option 3: Update types/escrow.ts

Update the `Escrow` type to match:

```typescript
export interface Escrow {
  escrowId: string;
  requester: string;
  provider: string;
  amount: bigint;
  releasedAmount: bigint;
  active: boolean;
}
```

## Important Notes

1. **onlyKernel modifier**: Most EscrowVault methods can only be called by the Kernel contract, not directly by users. The SDK should coordinate escrow operations through Kernel methods.

2. **MockRuntime vs BlockchainRuntime**: MockRuntime has its own escrow simulation that may work differently. This mismatch only affects real blockchain operations.

3. **Fund flow**: In the Protocol design:
   - Requester approves USDC to EscrowVault
   - Kernel calls `createEscrow()` which pulls funds from requester
   - On settlement, Kernel calls `payoutToProvider()` or `refundToRequester()`

## Action Required

Before deploying to testnet/mainnet:
1. Update `src/abi/EscrowVault.json` with correct ABI
2. Refactor `src/protocol/EscrowVault.ts` methods
3. Update `src/types/escrow.ts` interface
4. Update any tests that use old escrow methods
5. Verify against deployed contracts on Base Sepolia

## References

- Protocol EscrowVault: `AGIRAILS/Protocol/actp-kernel/src/escrow/EscrowVault.sol`
- Protocol Interface: `AGIRAILS/Protocol/actp-kernel/src/interfaces/IEscrowValidator.sol`
- SDK EscrowVault: `AGIRAILS/SDK and Runtime/sdk-js/src/protocol/EscrowVault.ts`
- SDK ABI: `AGIRAILS/SDK and Runtime/sdk-js/src/abi/EscrowVault.json`
