import { expect } from 'chai';
import { ethers } from 'hardhat';
import { ACTPClient, State } from '../../src';
import { BASE_SEPOLIA } from '../../src/config/networks';

const ONE_HOUR = 3600;

/**
 * AIP-2 Quote Workflow Integration Tests
 *
 * Tests INITIATED → QUOTED → COMMITTED workflow on deployed contracts
 * Reference: AIP-2 §4 (Workflow & State Transitions)
 *
 * Prerequisites:
 * - Set BASE_SEPOLIA_RPC in .env
 * - Set PRIVATE_KEY and PROVIDER_PRIVATE_KEY in .env
 * - Run: npx hardhat test --network base-sepolia
 */
describe('AIP-2 Quote Workflow - Base Sepolia Integration', () => {
  let requesterClient: ACTPClient;
  let providerClient: ACTPClient;
  let requester: any;
  let provider: any;

  before(async function () {
    // Skip if not on Base Sepolia network
    const network = await ethers.provider.getNetwork();
    if (Number(network.chainId) !== 84532) {
      console.log('⚠️  Skipping quote workflow tests - not on Base Sepolia network');
      console.log('   Run: npx hardhat test --network base-sepolia');
      this.skip();
      return;
    }

    const signers = await ethers.getSigners();
    if (signers.length < 2) {
      throw new Error('Need at least 2 signers (set PRIVATE_KEY and PROVIDER_PRIVATE_KEY in .env)');
    }

    requester = signers[0];
    provider = signers[1];

    console.log('🔗 Connected to Base Sepolia');
    console.log('   Requester (Consumer):', requester.address);
    console.log('   Provider:', provider.address);

    // Create SDK clients for both parties
    requesterClient = await ACTPClient.create({
      network: 'base-sepolia',
      signer: requester,
      provider: requester.provider
    });

    providerClient = await ACTPClient.create({
      network: 'base-sepolia',
      signer: provider,
      provider: provider.provider
    });

    // Mint test USDC for requester
    const usdcContract = new ethers.Contract(
      BASE_SEPOLIA.contracts.usdc,
      ['function mint(address to, uint256 amount) external'],
      requester
    );

    const mintAmount = ethers.parseUnits('500', 6);
    console.log('💰 Minting test USDC for requester...');
    const mintTx = await usdcContract.mint(requester.address, mintAmount);
    await mintTx.wait();
    console.log('   Minted:', ethers.formatUnits(mintAmount, 6), 'USDC');
  });

  it('completes full INITIATED → QUOTED → COMMITTED workflow', async function () {
    this.timeout(180000); // 3 minutes for network operations

    const originalAmount = ethers.parseUnits('50', 6); // $50 USDC
    const maxPrice = ethers.parseUnits('100', 6); // $100 USDC max
    const quotedAmount = ethers.parseUnits('75', 6); // $75 USDC (provider quotes 50% more)

    console.log('\n📝 Step 1: Consumer creates transaction in INITIATED state');
    const txId = await requesterClient.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount: originalAmount,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR,
      metadata: ethers.id('quote-test-1-lifecycle-' + Date.now())
    });
    console.log('   Transaction ID:', txId);
    console.log('   Original Amount: $50 USDC');
    console.log('   Max Price: $100 USDC');

    // Verify initial state
    let tx = await requesterClient.kernel.getTransaction(txId);
    expect(Number(tx.state)).to.equal(State.INITIATED);
    console.log('   ✅ State: INITIATED');

    console.log('\n💬 Step 2: Provider builds and signs quote message (off-chain)');
    const providerDID = `did:ethr:84532:${provider.address}`;
    const consumerDID = `did:ethr:84532:${requester.address}`;

    const quote = await providerClient.quote.build({
      txId,
      provider: providerDID,
      consumer: consumerDID,
      quotedAmount: quotedAmount.toString(),
      originalAmount: originalAmount.toString(),
      maxPrice: maxPrice.toString(),
      justification: {
        reason: 'Dataset size requires additional compute resources and processing time',
        estimatedTime: 300,
        computeCost: 25.0,
        breakdown: {
          basePrice: 50.0,
          additionalCompute: 25.0
        }
      },
      chainId: 84532,
      kernelAddress: BASE_SEPOLIA.contracts.actpKernel
    });
    console.log('   Quote Message:');
    console.log('     - Quoted Amount: $75 USDC (+50%)');
    console.log('     - Expires At:', new Date(quote.expiresAt * 1000).toISOString());
    console.log('     - Nonce:', quote.nonce);
    console.log('     - Signature:', quote.signature.substring(0, 20) + '...');

    // Compute quote hash for on-chain storage
    const quoteHash = providerClient.quote.computeHash(quote);
    console.log('   Quote Hash:', quoteHash);

    console.log('\n🔄 Step 3: Provider submits quote on-chain (INITIATED → QUOTED)');
    await providerClient.kernel.submitQuote(txId, quoteHash);
    console.log('   ✅ State transition submitted');

    // Verify state changed to QUOTED
    tx = await requesterClient.kernel.getTransaction(txId);
    expect(Number(tx.state)).to.equal(State.QUOTED);
    expect(tx.metadata).to.equal(quoteHash); // Quote hash stored on-chain
    console.log('   ✅ State: QUOTED');
    console.log('   ✅ Quote hash verified on-chain');

    console.log('\n🔍 Step 4: Consumer verifies quote (off-chain)');
    // Verify quote signature and business rules
    const isValid = await requesterClient.quote.verify(quote, BASE_SEPOLIA.contracts.actpKernel);
    expect(isValid).to.be.true;
    console.log('   ✅ Quote signature valid');
    console.log('   ✅ Business rules validated');

    // Verify quote hash matches on-chain
    const computedHash = requesterClient.quote.computeHash(quote);
    expect(computedHash).to.equal(tx.metadata);
    console.log('   ✅ Quote hash matches on-chain value');

    // Verify quoted amount within acceptable range
    const quotedAmountBN = BigInt(quote.quotedAmount);
    const originalAmountBN = BigInt(quote.originalAmount);
    const maxPriceBN = BigInt(quote.maxPrice);

    expect(quotedAmountBN >= originalAmountBN).to.be.true;
    expect(quotedAmountBN <= maxPriceBN).to.be.true;
    console.log('   ✅ Quoted amount within range [$50 ≤ $75 ≤ $100]');

    console.log('\n🔒 Step 5: Consumer accepts quote and prepares escrow with QUOTED amount');
    // Approve USDC to EscrowVault (must approve quoted amount, not original!)
    await requesterClient.escrow.approveToken(BASE_SEPOLIA.contracts.usdc, quotedAmount);
    console.log('   ✅ USDC approved: $75 USDC (quoted price, not original $50)');

    // Generate unique escrow ID
    const escrowId = ethers.id(`quote-escrow-${Date.now()}`);
    console.log('   Escrow ID:', escrowId);

    console.log('\n🔗 Step 6: Link escrow (auto-transitions QUOTED → COMMITTED)');
    await requesterClient.kernel.linkEscrow(txId, requesterClient.escrow.getAddress(), escrowId);
    console.log('   ✅ Escrow created and linked via Kernel');

    // Verify QUOTED → COMMITTED auto-transition after linkEscrow (ACTPKernel.sol line 270)
    tx = await requesterClient.kernel.getTransaction(txId);
    expect(Number(tx.state)).to.equal(State.COMMITTED);
    expect(tx.escrowContract).to.equal(requesterClient.escrow.getAddress());
    expect(tx.escrowId).to.equal(escrowId);
    console.log('   ✅ linkEscrow() auto-transitioned QUOTED → COMMITTED');
    console.log('   ✅ Escrow verification passed');

    console.log('\n✅ Quote workflow completed successfully!');
    console.log('   Summary:');
    console.log('   - Consumer offered: $50 USDC');
    console.log('   - Provider quoted: $75 USDC (+50%)');
    console.log('   - Consumer accepted: $75 USDC');
    console.log('   - Escrow locked: $75 USDC');
    console.log('   - Final state: COMMITTED (ready for service delivery)');
  });

  it('rejects quote above maxPrice', async function () {
    this.timeout(180000);

    const originalAmount = ethers.parseUnits('50', 6); // $50 USDC
    const maxPrice = ethers.parseUnits('100', 6); // $100 USDC max
    const excessiveQuote = ethers.parseUnits('150', 6); // $150 USDC (above max!)

    console.log('\n📝 Creating transaction with maxPrice limit...');
    const txId = await requesterClient.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount: originalAmount,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR,
      metadata: ethers.id('quote-test-2-max-price-' + Date.now())
    });
    console.log('   Transaction ID:', txId);
    console.log('   Max Price: $100 USDC');

    console.log('\n❌ Provider attempts to quote $150 (above $100 max)...');
    const providerDID = `did:ethr:84532:${provider.address}`;
    const consumerDID = `did:ethr:84532:${requester.address}`;

    // Should fail at build time (validation)
    try {
      await providerClient.quote.build({
        txId,
        provider: providerDID,
        consumer: consumerDID,
        quotedAmount: excessiveQuote.toString(),
        originalAmount: originalAmount.toString(),
        maxPrice: maxPrice.toString(),
        chainId: 84532,
        kernelAddress: BASE_SEPOLIA.contracts.actpKernel
      });
      expect.fail('Should have thrown validation error');
    } catch (error: any) {
      expect(error.message).to.include('quotedAmount must be <= maxPrice');
      console.log('   ✅ Quote rejected:', error.message);
    }
  });

  it('rejects quote below originalAmount', async function () {
    this.timeout(180000);

    const originalAmount = ethers.parseUnits('50', 6); // $50 USDC
    const maxPrice = ethers.parseUnits('100', 6); // $100 USDC max
    const lowballQuote = ethers.parseUnits('40', 6); // $40 USDC (below $50!)

    console.log('\n📝 Creating transaction...');
    const txId = await requesterClient.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount: originalAmount,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR,
      metadata: ethers.id('quote-test-3-min-amount-' + Date.now())
    });
    console.log('   Transaction ID:', txId);
    console.log('   Original Amount: $50 USDC');

    console.log('\n❌ Provider attempts to quote $40 (below $50 original)...');
    const providerDID = `did:ethr:84532:${provider.address}`;
    const consumerDID = `did:ethr:84532:${requester.address}`;

    // Should fail at build time (validation)
    try {
      await providerClient.quote.build({
        txId,
        provider: providerDID,
        consumer: consumerDID,
        quotedAmount: lowballQuote.toString(),
        originalAmount: originalAmount.toString(),
        maxPrice: maxPrice.toString(),
        chainId: 84532,
        kernelAddress: BASE_SEPOLIA.contracts.actpKernel
      });
      expect.fail('Should have thrown validation error');
    } catch (error: any) {
      expect(error.message).to.include('quotedAmount must be >= originalAmount');
      console.log('   ✅ Quote rejected:', error.message);
    }
  });

  it('prevents non-provider from submitting quote', async function () {
    this.timeout(180000);

    const originalAmount = ethers.parseUnits('50', 6);
    const maxPrice = ethers.parseUnits('100', 6);
    const quotedAmount = ethers.parseUnits('75', 6);

    console.log('\n📝 Creating transaction...');
    const txId = await requesterClient.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount: originalAmount,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR,
      metadata: ethers.id('quote-test-4-non-provider-' + Date.now())
    });

    console.log('\n❌ Requester (non-provider) attempts to submit quote...');
    const providerDID = `did:ethr:84532:${provider.address}`;
    const consumerDID = `did:ethr:84532:${requester.address}`;

    // Build quote as provider (valid signature)
    const quote = await providerClient.quote.build({
      txId,
      provider: providerDID,
      consumer: consumerDID,
      quotedAmount: quotedAmount.toString(),
      originalAmount: originalAmount.toString(),
      maxPrice: maxPrice.toString(),
      chainId: 84532,
      kernelAddress: BASE_SEPOLIA.contracts.actpKernel
    });

    const quoteHash = providerClient.quote.computeHash(quote);

    // Try to submit from requester's client (should fail on-chain)
    try {
      await requesterClient.kernel.submitQuote(txId, quoteHash);
      expect.fail('Should have reverted on-chain');
    } catch (error: any) {
      // On-chain revert expected
      console.log('   ✅ Transaction reverted:', error.message.substring(0, 100) + '...');
    }
  });

  it('prevents quote submission from non-INITIATED state', async function () {
    this.timeout(180000);

    const originalAmount = ethers.parseUnits('50', 6);
    const maxPrice = ethers.parseUnits('100', 6);
    const quotedAmount = ethers.parseUnits('75', 6);

    console.log('\n📝 Creating transaction and moving to QUOTED...');
    const txId = await requesterClient.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount: originalAmount,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR,
      metadata: ethers.id('quote-test-5-wrong-state-' + Date.now())
    });

    // First quote (valid)
    const providerDID = `did:ethr:84532:${provider.address}`;
    const consumerDID = `did:ethr:84532:${requester.address}`;

    const quote1 = await providerClient.quote.build({
      txId,
      provider: providerDID,
      consumer: consumerDID,
      quotedAmount: quotedAmount.toString(),
      originalAmount: originalAmount.toString(),
      maxPrice: maxPrice.toString(),
      chainId: 84532,
      kernelAddress: BASE_SEPOLIA.contracts.actpKernel
    });

    const quoteHash1 = providerClient.quote.computeHash(quote1);
    await providerClient.kernel.submitQuote(txId, quoteHash1);
    console.log('   ✅ First quote submitted (INITIATED → QUOTED)');

    console.log('\n❌ Provider attempts to submit second quote (already in QUOTED state)...');
    const quote2 = await providerClient.quote.build({
      txId,
      provider: providerDID,
      consumer: consumerDID,
      quotedAmount: ethers.parseUnits('80', 6).toString(), // Different quote
      originalAmount: originalAmount.toString(),
      maxPrice: maxPrice.toString(),
      chainId: 84532,
      kernelAddress: BASE_SEPOLIA.contracts.actpKernel
    });

    const quoteHash2 = providerClient.quote.computeHash(quote2);

    // Should fail - SDK validation catches it before on-chain submission
    try {
      await providerClient.kernel.submitQuote(txId, quoteHash2);
      expect.fail('Should have failed state validation');
    } catch (error: any) {
      console.log('   ✅ Quote rejected:', error.message.substring(0, 100) + '...');
      expect(error.message).to.include('Invalid');
    }
  });
});
