# Known Limitations (V1)

This document outlines known limitations in AGIRAILS SDK V1 and provides workarounds for production usage.

## Network Resilience

### No Automatic Retry Logic

**Limitation**: SDK does not automatically retry failed RPC calls or transaction submissions.

**Impact**: Network failures (RPC timeouts, connection drops) will cause transactions to fail without retry.

**Affected Methods**:
- `createTransaction()`
- `transitionState()`
- `linkEscrow()`
- `releaseEscrow()`
- `verifyDeliveryAttestation()`

**Workaround**:
```typescript
import { ACTPClient } from '@agirails/sdk';

// Manual retry pattern with exponential backoff
async function createTransactionWithRetry(
  client: ACTPClient,
  params: any,
  maxRetries = 3
): Promise<string> {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const txId = await client.kernel.createTransaction(params);
      return txId;
    } catch (error: any) {
      lastError = error;

      // Only retry on network errors
      if (error.code === 'NETWORK_ERROR' ||
          error.code === 'TIMEOUT' ||
          error.message.includes('network')) {

        const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(`Retry ${attempt + 1}/${maxRetries} after ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      // Don't retry on validation errors or contract reverts
      throw error;
    }
  }

  throw new Error(`Failed after ${maxRetries} retries: ${lastError.message}`);
}
```

**Planned Fix**: V1.1 (automatic retry with configurable backoff)

---

### No Transaction Wait Timeout

**Limitation**: `tx.wait()` may hang indefinitely if RPC provider becomes unresponsive.

**Impact**: Application may freeze waiting for transaction confirmation.

**Workaround**:
```typescript
// Timeout wrapper for tx.wait()
async function waitWithTimeout(
  txPromise: Promise<any>,
  timeoutMs = 60000 // 60 seconds
): Promise<any> {
  return Promise.race([
    txPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Transaction wait timeout')), timeoutMs)
    )
  ]);
}

// Usage
try {
  const txId = await client.kernel.createTransaction(params);
  // Wait with 60-second timeout
  await waitWithTimeout(
    client.kernel.getTransaction(txId),
    60000
  );
} catch (error) {
  if (error.message === 'Transaction wait timeout') {
    // Transaction may still be pending - check on-chain
    console.log('Transaction timed out, checking status manually...');
    // Implement manual status polling here
  }
  throw error;
}
```

**Planned Fix**: V1.1 (configurable timeout in SDK)

---

### No RPC Provider Fallback

**Limitation**: SDK uses single RPC endpoint. If provider goes down, all operations fail.

**Impact**: Dependency on single RPC provider creates single point of failure.

**Workaround**:
```typescript
// Multi-provider fallback pattern
import { ACTPClient } from '@agirails/sdk';

const providers = [
  'https://base-sepolia.g.alchemy.com/v2/YOUR_KEY_1',
  'https://base-sepolia.infura.io/v3/YOUR_KEY_2',
  'https://public.base-sepolia.rpc'
];

async function createClientWithFallback(): Promise<ACTPClient> {
  let lastError;

  for (const rpcUrl of providers) {
    try {
      const client = await ACTPClient.create({
        network: 'base-sepolia',
        rpcUrl,
        privateKey: process.env.PRIVATE_KEY
      });

      // Test connectivity
      await client.kernel.getTransaction('0x' + '0'.repeat(64));
      return client;
    } catch (error) {
      lastError = error;
      console.log(`Provider ${rpcUrl} failed, trying next...`);
    }
  }

  throw new Error(`All RPC providers failed: ${lastError.message}`);
}
```

**Planned Fix**: V2 (multi-provider with automatic failover)

---

## State Transition Race Conditions

### TOCTOU (Time-of-Check-Time-of-Use) in State Validation

**Limitation**: SDK checks transaction state before submitting state transition, but state may change between check and on-chain execution.

**Impact**: Race condition where state changes after SDK validation but before contract execution.

**Example Scenario**:
```typescript
// T1: SDK checks state
const tx = await client.kernel.getTransaction(txId);
if (tx.state !== State.DELIVERED) {
  throw new Error('Cannot release escrow');
}

// T2: Another user transitions state (front-running or legitimate)
// State changes: DELIVERED → DISPUTED

// T3: SDK submits transaction
await client.kernel.releaseEscrow(txId); // ❌ Contract reverts: "Invalid state"
```

**Mitigation**:
- SDK-side validation is **advisory only**
- **Contract provides final validation** (lines 280-293 in ACTPKernel.ts)
- Contract will revert if state has changed
- Use try-catch and check error message for "Invalid state transition"

**Workaround**:
```typescript
try {
  await client.kernel.releaseEscrow(txId);
} catch (error: any) {
  if (error.message.includes('Invalid state transition')) {
    // Re-fetch current state and decide action
    const currentTx = await client.kernel.getTransaction(txId);
    console.log(`State changed to ${currentTx.state}, handling...`);

    if (currentTx.state === State.DISPUTED) {
      // Handle dispute flow
    } else if (currentTx.state === State.SETTLED) {
      // Already settled, no action needed
    }
  } else {
    throw error;
  }
}
```

**Planned Fix**: V2 (optimistic concurrency control with version numbers)

---

### Attestation Revocation Race Condition

**Limitation**: EAS attestation can be revoked between SDK verification and on-chain settlement.

**Timeline**:
1. Consumer calls `verifyDeliveryAttestation(txId, attestationUID)` → PASS ✅
2. Provider calls `eas.revokeAttestation(attestationUID)` → Revoked ❌
3. Consumer calls `releaseEscrow(txId)` → Funds released (no re-verification)

**Impact**: Malicious provider can revoke attestation after consumer verification but before settlement.

**Mitigation**:
- V1 contract does NOT validate attestations on-chain (documented in AIP-4)
- SDK verification is **defense layer** but not atomic with settlement
- Use short time windows between verify and settle (minimize race window)

**Workaround**:
```typescript
// Minimize race window by verifying immediately before settlement
async function safeReleaseWithVerification(
  client: ACTPClient,
  txId: string,
  attestationUID: string
): Promise<void> {
  // Atomic verify + settle pattern
  try {
    await client.eas.verifyDeliveryAttestation(txId, attestationUID);
    // Immediately settle (minimize race window)
    await client.kernel.releaseEscrow(txId);
  } catch (error: any) {
    if (error.message.includes('revoked')) {
      console.log('Attestation was revoked, investigating...');
      // Check revocation timestamp vs verification timestamp
      // Decide: Was this revoked BEFORE delivery or AFTER verification?
    }
    throw error;
  }
}
```

**Recommended**: Use `ACTPClient.releaseEscrowWithVerification()` which minimizes race window.

**Planned Fix**: V2 (on-chain attestation validation - atomic verify + settle)

---

## Gas Estimation Limitations

### Gas Estimates May Become Stale During Network Congestion

**Limitation**: SDK estimates gas before submission, but network conditions may change.

**Impact**: Transaction may be underpriced and stuck in mempool during gas price spikes.

**Affected**: All state-changing operations (`createTransaction`, `releaseEscrow`, etc.)

**Workaround**:
```typescript
// Manual gas price override during high congestion
const feeData = await client.provider.getFeeData();

// Use 2x current max fee during congestion
const maxFeePerGas = feeData.maxFeePerGas! * 2n;
const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas! * 2n;

await client.kernel.createTransaction(params, {
  maxFeePerGas,
  maxPriorityFeePerGas
});
```

**Planned Fix**: V1.1 (dynamic gas adjustment based on network conditions)

---

### Gas Buffers Are Static Per Operation

**Limitation**: SDK applies fixed gas buffers (15-30%) based on operation type, not transaction complexity.

**Current Buffers**:
- `createTransaction`: 15%
- `transitionState`: 20%
- `linkEscrow`: 20%
- `releaseEscrow`: 30% (multiple transfers)
- `raiseDispute`: 25% (proof data)
- `anchorAttestation`: 15%

**Impact**: Complex transactions (large proof data, many milestones) may still run out of gas.

**Workaround**:
```typescript
// Manual gas limit for complex transactions
const estimatedGas = await client.kernel.contract
  .getFunction('raiseDispute')
  .estimateGas(txId, reason, largeProofData);

// Add custom buffer for large data
const gasLimit = estimatedGas * 150n / 100n; // 50% buffer

await client.kernel.raiseDispute(txId, reason, largeProofData, {
  gasLimit
});
```

**Planned Fix**: V2 (dynamic buffer based on calldata size and state complexity)

---

## Error Recovery

### No Nonce Conflict Resolution

**Limitation**: SDK does not track nonce conflicts or provide retry with updated nonce.

**Impact**: After RPC failure, retrying may cause "nonce already used" errors.

**Workaround**:
```typescript
import { NonceManager } from '@ethersproject/experimental';

// Wrap signer with nonce manager
const managedSigner = new NonceManager(signer);

const client = await ACTPClient.create({
  network: 'base-sepolia',
  signer: managedSigner, // Use managed signer instead of privateKey
  // ... other config
});

// NonceManager automatically handles nonce conflicts
```

**Planned Fix**: V1.1 (built-in nonce manager)

---

### No Transaction Status Polling

**Limitation**: SDK does not provide transaction status polling after `tx.wait()` fails.

**Impact**: User must manually check on-chain if transaction confirmed after timeout.

**Workaround**:
```typescript
async function pollTransactionStatus(
  client: ACTPClient,
  txHash: string,
  maxAttempts = 20
): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const receipt = await client.provider.getTransactionReceipt(txHash);
      if (receipt) {
        return receipt; // Transaction confirmed
      }
    } catch (error) {
      console.log(`Polling attempt ${i + 1}/${maxAttempts}...`);
    }

    await new Promise(resolve => setTimeout(resolve, 3000)); // 3s delay
  }

  throw new Error('Transaction status unknown after polling');
}
```

**Planned Fix**: V1.1 (built-in status polling with timeout)

---

## Documentation

### Limited Production Recovery Examples

**Limitation**: SDK documentation focuses on happy path, minimal error recovery examples.

**Impact**: Developers may not handle failures correctly in production.

**Resource**: See this document for workaround patterns.

**Planned Fix**: V1.1 (comprehensive production deployment guide)

---

## Versioning & Compatibility

### ethers.js v6 Only

**Limitation**: SDK requires ethers.js v6. Not compatible with v5 or earlier.

**Impact**: Projects using ethers v5 must upgrade to use this SDK.

**Migration**: See [ethers v6 migration guide](https://docs.ethers.org/v6/migrating/)

---

### Contract Version Coupling

**Limitation**: SDK is tightly coupled to specific ACTPKernel contract version.

**Current Contract**: ACTPKernel V1 (deployed at 0x...)

**Impact**: SDK cannot interact with future contract versions without upgrade.

**Workaround**: Check contract version before operations:
```typescript
// Verify contract version matches SDK expectations
const contractVersion = await client.kernel.contract.version();
if (contractVersion !== '1.0.0') {
  console.warn('Contract version mismatch, some features may not work');
}
```

**Planned Fix**: V2 (version negotiation protocol)

---

## Roadmap

### V1.1 (Estimated: 2-4 weeks)
- ✅ Automatic retry with exponential backoff
- ✅ Configurable timeouts for `tx.wait()`
- ✅ Built-in nonce manager
- ✅ Transaction status polling
- ✅ Dynamic gas adjustment

### V2.0 (Estimated: 3-6 months)
- ✅ On-chain attestation validation (atomic verify + settle)
- ✅ Optimistic concurrency control (TOCTOU mitigation)
- ✅ Multi-provider fallback
- ✅ Contract version negotiation
- ✅ Event-driven architecture (webhooks)

### Research / Investigation
- 🔍 **IPFS vs Arweave for delivery proofs** - Current IPFS dependency (`kubo-rpc-client`) adds 400+ transitive packages. Evaluate Arweave as lighter-weight alternative with permanent storage guarantees. Consider making storage provider optional/pluggable.

---

## Support

For questions or issues related to these limitations:

- **GitHub Issues**: https://github.com/agirails/sdk/issues
- **Discord**: https://discord.gg/agirails
- **Email**: developers@agirails.io

**Security Issues**: security@agirails.io (do not disclose publicly)

---

**Document Version**: 1.0.0
**Last Updated**: 2025-11-23
**SDK Version**: 0.1.0-beta.2
