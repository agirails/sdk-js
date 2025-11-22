# ACTP Test Scripts

Comprehensive test scripts for ACTP protocol on Base Sepolia testnet.

## Test Wallets

- **Client**: `0xe174bd855aaA8d907334288323044d4cf79BfAfC`
- **Provider**: `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`

## Setup

1. **Create `.env` file** (copy from `.env.example`):
   ```bash
   cp .env.example .env
   ```

2. **Add private keys** to `.env`:
   ```bash
   ADMIN_PRIVATE_KEY=0x...      # Wallet that can mint USDC
   CLIENT_PRIVATE_KEY=0x...     # Client test wallet
   PROVIDER_PRIVATE_KEY=0x...   # Provider test wallet
   ```

3. **Ensure wallets have ETH** on Base Sepolia (for gas fees)

## Running Tests

### 1. Setup (Mint USDC)
```bash
npm run test:setup
```
Mints 10,000 USDC to both client and provider wallets.

### 2. Happy Path Test
```bash
npm run test:happy-path
```
Tests full transaction lifecycle:
- Client creates transaction
- Client links escrow (100 USDC)
- Provider starts work
- Provider delivers
- Client releases payment

**Expected outcome**: Provider receives 99 USDC, platform gets 1 USDC fee.

### 3. Dispute Test
```bash
npm run test:dispute
```
Tests dispute resolution:
- Client creates and funds transaction
- Provider delivers work
- Client raises dispute
- Admin resolves with 70/30 split (provider favored)

**Expected outcome**: Provider gets 70 USDC, client gets 30 USDC refund.

### 4. Cancellation Test
```bash
npm run test:cancel
```
Tests two cancellation scenarios:
- Cancel before escrow link (no funds involved)
- Cancel after escrow link (funds refunded)

**Expected outcome**: Client gets full refund in both cases.

### 5. Check Status
```bash
npm run test:status [txId]
```
Shows wallet balances and optionally transaction details.

**Examples**:
```bash
# Check balances only
npm run test:status

# Check specific transaction
npm run test:status 0x1234...
```

### 6. Run All Tests
```bash
npm run test:all
```
Runs setup + all test scenarios sequentially.

## Test Scripts

| Script | Description | Duration |
|--------|-------------|----------|
| `00-setup.ts` | Mint MockUSDC to test wallets | ~30s |
| `01-happy-path.ts` | Full transaction lifecycle | ~60s |
| `02-dispute.ts` | Dispute resolution flow | ~60s |
| `03-cancel.ts` | Cancellation scenarios | ~45s |
| `status.ts` | Check balances and transaction status | ~5s |

## Deployed Contracts (Base Sepolia)

```
MockUSDC:    0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb
ACTPKernel:  0xb5B002A73743765450d427e2F8a472C24FDABF9b
EscrowVault: 0x67770791c83eA8e46D8a08E09682488ba584744f
```

All verified on [Basescan](https://sepolia.basescan.org).

## Expected Gas Costs

| Operation | Gas | Cost @ 0.5 gwei |
|-----------|-----|-----------------|
| Create transaction | ~85k | ~$0.04 |
| Link escrow | ~45k | ~$0.02 |
| Transition state | ~30k | ~$0.015 |
| Release payment | ~50k | ~$0.025 |
| **Happy path total** | ~210k | ~$0.10 |

## Troubleshooting

### "Insufficient allowance"
Make sure you approved ACTPKernel to spend USDC before linking escrow.

### "Transaction reverted: Invalid state transition"
Check current transaction state - transitions must follow the state machine.

### "ADMIN_PRIVATE_KEY not set"
Add your admin private key to `.env` file.

### "Insufficient funds"
Run `npm run test:setup` to mint MockUSDC to test wallets.

## State Machine

```
INITIATED (0) → QUOTED (1) → COMMITTED (2) → IN_PROGRESS (3)
                                ↓
                          DELIVERED (4) → DISPUTED (6) → SETTLED (5)
                                ↓              ↓
                          SETTLED (5)    CANCELLED (7)
```

Valid transitions:
- 0→1, 0→2, 0→7
- 1→2, 1→7
- 2→3, 2→7
- 3→4
- 4→5, 4→6
- 6→5

## Support

For issues, contact `damir@agirails.io` or `justin@agirails.io`.
