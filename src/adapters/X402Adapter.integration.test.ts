/**
 * X402Adapter integration test against the live Coinbase reference endpoint
 * https://x402.org/protected (Base Sepolia USDC $0.01).
 *
 * Guarded by `INTEGRATION=1` env var — not run in CI by default to keep
 * build times low and because it requires a funded Base Sepolia wallet.
 *
 * Run with:
 *   INTEGRATION=1 \
 *   X402_TEST_PRIVATE_KEY=0x... \
 *   BASE_SEPOLIA_RPC=https://sepolia.base.org \
 *   npx jest src/adapters/X402Adapter.integration.test.ts
 *
 * The test wallet must hold at least 0.1 USDC on Base Sepolia for the
 * payment to succeed. Use Circle's faucet or the AGIRAILS dev faucet.
 *
 * Expected result:
 *   - HTTP 200 from x402.org/protected after payment-signature retry
 *   - payment-response header present with transaction hash
 *   - UnifiedPayResult.success === true
 *   - UnifiedPayResult.state === 'COMMITTED'
 *
 * @module adapters/X402Adapter.integration.test
 */

import { X402Adapter } from './X402Adapter';
import { EOAWalletProvider } from '../wallet/EOAWalletProvider';
import { ethers } from 'ethers';

const INTEGRATION = process.env.INTEGRATION === '1';
const PRIVATE_KEY = process.env.X402_TEST_PRIVATE_KEY;
const RPC_URL =
  process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';

const X402_TEST_URL = 'https://www.x402.org/protected';

// Use describe.skip when INTEGRATION is not set so Jest doesn't complain
// about missing env vars in regular test runs.
const maybeDescribe = INTEGRATION && PRIVATE_KEY ? describe : describe.skip;

maybeDescribe('X402Adapter — integration test (live x402.org/protected)', () => {
  let adapter: X402Adapter;

  beforeAll(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY!, provider);
    const walletProvider = new EOAWalletProvider(wallet, 84532); // Base Sepolia
    adapter = new X402Adapter({
      walletProvider,
      allowedNetworks: ['eip155:84532'],
      maxAmountPerTx: '1', // $1 cap — endpoint asks for $0.01
    });
  });

  it(
    'pays x402.org/protected end-to-end and returns SETTLED result',
    async () => {
      const result = await adapter.pay({ to: X402_TEST_URL });

      expect(result.success).toBe(true);
      expect(result.adapter).toBe('x402');
      expect(result.txId).toBeTruthy();
      expect(result.releaseRequired).toBe(false);
      // Settlement state comes back as COMMITTED since x402 settles atomically
      // via facilitator; our UnifiedPayResult shape uses InitialTransactionState
      // which doesn't have SETTLED. Callers should treat COMMITTED+x402 as final.
      expect(result.state).toBe('COMMITTED');

      // Log details for manual verification
      // eslint-disable-next-line no-console
      console.log('x402 integration test success:', {
        txId: result.txId,
        amount: result.amount,
        provider: result.provider,
      });
    },
    60000 // 60s timeout — facilitator settlement can take time on testnet
  );
});

// Always-on placeholder test so the file is not empty when skipped.
describe('X402Adapter integration test harness', () => {
  it('is guarded by INTEGRATION env var', () => {
    expect(typeof INTEGRATION).toBe('boolean');
  });
});
