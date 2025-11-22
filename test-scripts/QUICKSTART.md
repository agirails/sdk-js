# 🚀 Quick Start - ACTP Testing

5-minute guide to test ACTP protocol on Base Sepolia.

## Prerequisites

✅ Node.js 16+ installed
✅ Test wallets have ETH on Base Sepolia (for gas)
✅ Private keys for test wallets

## Step 1: Install Dependencies

```bash
cd "SDK and Runtime/sdk-js"
npm install
npm run build
```

## Step 2: Setup Environment

```bash
# Create .env file
cp .env.example .env

# Edit .env and add your private keys:
nano .env
```

Add these lines:
```bash
ADMIN_PRIVATE_KEY=0x...      # Wallet with admin rights (can mint USDC)
CLIENT_PRIVATE_KEY=0x...     # Client: 0xe174bd855aaA8d907334288323044d4cf79BfAfC
PROVIDER_PRIVATE_KEY=0x...   # Provider: 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
```

## Step 3: Mint Test USDC

```bash
npm run test:setup
```

Expected output:
```
💰 Minting 10,000 USDC to CLIENT...
   ✅ Confirmed!
💰 Minting 10,000 USDC to PROVIDER...
   ✅ Confirmed!
📊 Final Balances:
   Client:   10000.0 USDC
   Provider: 10000.0 USDC
```

## Step 4: Run Happy Path Test

```bash
npm run test:happy-path
```

This will:
1. Create transaction (100 USDC)
2. Link escrow
3. Provider works and delivers
4. Payment released

Expected: Provider gets 99 USDC, platform gets 1 USDC fee.

## Step 5: Check Status

```bash
npm run test:status
```

Shows balances:
```
Client Wallet: 0xe174bd855aaA8d907334288323044d4cf79BfAfC
  ETH:   0.05 ETH
  USDC:  9900.0 USDC  (spent 100 USDC)

Provider Wallet: 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
  ETH:   0.05 ETH
  USDC:  10099.0 USDC  (received 99 USDC)
```

## Optional: More Tests

### Test Dispute Flow
```bash
npm run test:dispute
```

### Test Cancellation
```bash
npm run test:cancel
```

### Run All Tests
```bash
npm run test:all
```

## Troubleshooting

### Missing ts-node
```bash
npm install --save-dev ts-node
```

### Insufficient ETH for gas
Get Base Sepolia ETH from:
- https://www.alchemy.com/faucets/base-sepolia
- https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet

### Transaction reverts
Check wallet has USDC:
```bash
npm run test:status
```

If USDC = 0, run:
```bash
npm run test:setup
```

## Next Steps

✅ Tests passing? Great!
✅ Now integrate ACTP SDK into your app
✅ See `test-scripts/` for SDK usage examples

## Contract Addresses

```
Network:     Base Sepolia (chainId: 84532)
RPC:         https://sepolia.base.org
Explorer:    https://sepolia.basescan.org

MockUSDC:    0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb
ACTPKernel:  0xb5B002A73743765450d427e2F8a472C24FDABF9b
EscrowVault: 0x67770791c83eA8e46D8a08E09682488ba584744f
```

## Support

Questions? Contact team@agirails.io
