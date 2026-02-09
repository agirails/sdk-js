# AGIRAILS SDK — Operations & Rollback Playbook

> Audience: SDK operators, on-call engineers, DevOps.
> Last updated: 2026-02-09

---

## Architecture Overview

```
Agent (SDK)
  │
  ├─ Tier 1 (AutoWalletProvider) ─────────────────────────────────────┐
  │   ├─ UserOp Builder → PaymasterClient → BundlerClient → EntryPoint
  │   │                    │                  │
  │   │   Coinbase CDP ◄──┤   Coinbase CDP ◄──┤
  │   │   Pimlico      ◄──┘   Pimlico      ◄──┘
  │   │
  │   └─ CoinbaseSmartWallet (ERC-4337, counterfactual CREATE2)
  │
  ├─ Tier 2 (EOAWalletProvider) ── ethers.Wallet → RPC → Base L2
  │
  └─ Read-only ── BlockchainRuntime → RPC → Base L2
```

**Key external dependencies:**
| Service | Role | Default | Override |
|---------|------|---------|----------|
| Paymaster | Gas sponsorship | Coinbase CDP | Pimlico (via `PIMLICO_API_KEY`) |
| Bundler | UserOp submission | Coinbase CDP | Pimlico (via `PIMLICO_API_KEY`) |
| RPC | Chain reads/writes | `sepolia.base.org` / `mainnet.base.org` | `BASE_SEPOLIA_RPC` / `BASE_MAINNET_RPC` env var |
| IPFS | Delivery proof storage | Configured gateway | — |

---

## Incident Runbooks

### 1. Paymaster Outage

**Symptoms:**
- `Gas sponsorship temporarily unavailable — both Coinbase and Pimlico paymasters failed`
- Tier 1 (Smart Wallet) payments fail
- Tier 2 (EOA) payments unaffected

**Detection:**
- Error class: `PaymasterError` or generic `Error` from `PaymasterClient.getPaymasterData()`
- Logs: `[PaymasterClient] Primary paymaster failed: ...`, `[PaymasterClient] Backup paymaster also failed: ...`

**Impact:** Tier 1 agents cannot send transactions. No funds at risk — UserOps are unsigned until paymaster provides `paymasterAndData`.

**Diagnosis:**
```bash
# Check Coinbase CDP status
curl -s -X POST https://api.developer.coinbase.com/rpc/v1/base-sepolia/$CDP_API_KEY \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"pm_getPaymasterStubData","params":["0x","0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789","0x14a34",{}]}' \
  | jq .

# Check Pimlico status
curl -s -X POST "https://api.pimlico.io/v2/base-sepolia/rpc?apikey=$PIMLICO_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"pm_getPaymasterStubData","params":["0x","0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789","0x14a34",{}]}' \
  | jq .
```

**Resolution:**
1. **Wait** — SDK will retry on next `pay()` call (no persistent circuit breaker)
2. **Switch to EOA** — set `wallet: undefined` + provide `privateKey` in config to bypass AA
3. **Check billing** — Coinbase CDP suspends accounts with overdue invoices
4. **Check rate limits** — Pimlico has per-second rate limits on free tier

**Rollback:**
- No on-chain state was modified — nothing to roll back
- Agents can safely retry the same payment

---

### 2. Bundler Outage

**Symptoms:**
- `Bundler RPC error [code]: [message]` after retries exhausted
- UserOps submitted but never included
- Receipts time out after 60 s

**Detection:**
- `BundlerClient.sendUserOperation()` throws after 2 retries per endpoint
- `BundlerClient.waitForReceipt()` times out (60 s default)

**Impact:** Tier 1 transactions are not submitted on-chain. No funds at risk — UserOps only reach the bundler, not the chain, until successfully included.

**Diagnosis:**
```bash
# Check Coinbase bundler
curl -s -X POST https://api.developer.coinbase.com/rpc/v1/base-sepolia/$CDP_API_KEY \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_supportedEntryPoints","params":[]}' \
  | jq .

# Check Pimlico bundler
curl -s -X POST "https://api.pimlico.io/v2/base-sepolia/rpc?apikey=$PIMLICO_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_supportedEntryPoints","params":[]}' \
  | jq .
```

**Resolution:**
1. **Wait + retry** — bundler makes up to 3 attempts per endpoint (1 initial + 2 retries, exponential backoff 1 s → 2 s). Non-transient AA errors (`AA21`, etc.) are thrown immediately without retry.
2. **Check UserOp validity** — AA validation errors (`AA21`, `AA25`, `AA31`) are not retried (they indicate logic bugs, not transient failures)
3. **Switch to EOA** — bypass bundler entirely with direct ethers transactions

**Rollback:**
- If UserOp was submitted but not included: the bundler drops it after timeout
- If UserOp was included: on-chain state was modified, no rollback possible (use dispute flow instead)
- `DualNonceManager.enqueue()` resets its cached ACTP nonce on failure (line 116-117, 122) — next call re-reads nonces from chain. Safe to retry.

---

### 3. Reorg Recovery

**Context:**
- Base L2 blocks are ~2 s
- SDK uses configurable confirmation depth (default: 2 blocks via `confirmations` in config)
- L2 transactions are finalized after Ethereum L1 checkpoint (~15 min)

**Symptoms:**
- Transaction receipt exists but state reverts to previous value
- EventMonitor receives duplicate or contradictory state transitions
- `getTransaction()` returns stale state

**Impact:** On Base L2 with 2-block confirmations, reorgs deeper than 2 blocks are extremely rare. In the unlikely event:

**Diagnosis:**
```bash
# Check block number discrepancy
cast block-number --rpc-url $BASE_SEPOLIA_RPC
# Compare with receipt block number — if receipt block > current, reorg occurred
```

**Resolution:**
1. **Increase confirmations** — set `confirmations: 5` or higher in `BlockchainRuntimeConfig` for higher-value transactions
2. **Re-read state** — call `kernel.getTransaction(txId)` to get canonical state
3. **Re-submit if needed** — if the tx was dropped in the reorg, the nonce is freed and the tx can be resubmitted
4. **For critical settlement (>$10K)** — wait for L1 finality before releasing escrow (~15 min on Base)

**Prevention:**
```typescript
// High-value transactions: use more confirmations
const runtime = new BlockchainRuntime({
  network: 'base-mainnet',
  signer,
  provider,
  confirmations: 5 // ~10s on Base L2 — deeper reorg protection
});
```

---

### 4. RPC Provider Outage

**Symptoms:**
- All operations fail (read + write)
- `JsonRpcProvider` connection errors
- `Base Sepolia public RPC has 503 issues`

**Detection:**
- ethers throws `SERVER_ERROR`, `NETWORK_ERROR`, or `TIMEOUT` errors

**Resolution:**
1. **Override RPC** — set `BASE_SEPOLIA_RPC` or `BASE_MAINNET_RPC` env var to point at a different provider
2. **Default RPCs (from `networks.ts`):**
   - Sepolia: `https://sepolia.base.org` (rate-limited public)
   - Mainnet: `https://mainnet.base.org` (rate-limited public)
3. **Recommended alternatives:**
   - Alchemy: `https://base-sepolia.g.alchemy.com/v2/$ALCHEMY_KEY`
   - PublicNode: `https://base-sepolia-rpc.publicnode.com`
4. **For Tier 1 (AA):** bundler/paymaster have their own RPC — they may still work even if SDK's RPC is down

**Rollback:**
- Read failures: no state change, safe to retry
- Write failures mid-flight: check tx hash on block explorer before retrying (avoid double-spend)

---

### 5. Smart Wallet Deployment Failure

**Symptoms:**
- First Tier 1 transaction fails
- `initCode` in UserOp causes AA-level revert
- Error codes: `AA13` (initCode failed), `AA14` (initCode+sender mismatch)

**Diagnosis:**
- Verify counterfactual address matches: compare `computeSmartWalletAddress()` output with actual deployed address
- Check that `CoinbaseSmartWalletFactory` is accessible at `0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842`

**Resolution:**
1. **Verify signer** — ensure the same private key is used (different key = different Smart Wallet address)
2. **Check factory** — factory address is hardcoded, verify it's responsive on current network
3. **Fall back to EOA** — if factory is broken, switch to Tier 2

---

## Configuration Reference

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CDP_API_KEY` | Tier 1 | Coinbase Developer Platform API key |
| `PIMLICO_API_KEY` | No | Pimlico API key (backup paymaster/bundler) |
| `ACTP_KEY_PASSWORD` | Tier 1 | Keystore decryption password |
| `ACTP_PRIVATE_KEY` | Tier 2 | Direct private key (alternative to keystore) |
| `BASE_SEPOLIA_RPC` | No | Custom RPC URL (default: `https://sepolia.base.org`) |
| `BASE_MAINNET_RPC` | No | Custom RPC URL (default: `https://mainnet.base.org`) |

### Timeouts

| Component | Default | Configurable |
|-----------|---------|-------------|
| Paymaster RPC | 15 s | `PaymasterConfig.timeoutMs` |
| Bundler RPC | 30 s | `BundlerConfig.timeoutMs` |
| Bundler receipt poll | 60 s | `waitForReceipt()` params |
| Block confirmations | 2 blocks (~4 s) | `BlockchainRuntimeConfig.confirmations` |

### Retry Behavior

| Component | Retries | Backoff | Notes |
|-----------|---------|---------|-------|
| Paymaster | 0 per endpoint | — | Immediate failover to backup |
| Bundler | 2 per endpoint (3 total attempts) | 1 s, 2 s (exponential) | Non-transient AA errors (`AA*`) skip retry |
| DualNonceManager | 0 | — | Resets cached ACTP nonce on failure; next `enqueue()` re-reads from chain |

---

## Health Checks

### Pre-flight (before sending a payment)

```typescript
// 1. Verify RPC is reachable
const blockNumber = await provider.getBlockNumber();

// 2. Verify USDC balance is sufficient
const usdc = new ethers.Contract(usdcAddress, ['function balanceOf(address) view returns (uint256)'], provider);
const balance = await usdc.balanceOf(walletAddress);

// 3. Verify agent is registered (Tier 1 only)
const registry = new AgentRegistryClient(provider, registryAddress);
const profile = await registry.getAgent(walletAddress);
```

### Post-incident

1. **Verify no stuck transactions** — check `requesterNonces` for the agent address; if nonce incremented, tx was created
2. **Verify escrow state** — call `getTransaction(txId)` for any in-flight txIds
3. **Verify USDC balances** — compare agent + escrow vault balances against expected

---

## Known Limitations

1. **No circuit breaker** for paymaster/bundler — SDK retries on every call. If a provider is consistently failing, every call pays the full retry cost.
2. **No persistent retry queue** — if the process dies mid-flight, the retry state is lost. Application layer must track pending payments.
3. **No automatic EOA fallback** — Tier 1 failure requires manual config change to switch to Tier 2.
4. **No alerting hooks** — errors are logged via `sdkLogger` but not dispatched to external monitoring.
5. **AgentRegistry/DIDManager** use hardcoded 2-block confirmations (not yet configurable like ACTPKernel).
