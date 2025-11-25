import { expect } from 'chai';
import { ethers } from 'hardhat';
import { ACTPClient, State, ProofGenerator, deliveryProofDataFromProof, DeliveryProofTypes } from '../../src';
import { BASE_SEPOLIA } from '../../src/config/networks';

const ONE_HOUR = 3600;

/**
 * ACTP SDK Integration Tests - Base Sepolia Testnet
 *
 * These tests run against DEPLOYED contracts on Base Sepolia:
 * - ACTPKernel: 0x7Cb7867C3D2BAd7AE4ee236B5FddC0AFEc633370
 * - EscrowVault: 0x41D45491451C5AE318fdb4f0Bc224d628571FC0F
 * - MockUSDC: 0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb
 *
 * Prerequisites:
 * - Set BASE_SEPOLIA_RPC in .env
 * - Set PRIVATE_KEY in .env (account with Base Sepolia ETH for gas)
 * - Run: npx hardhat test --network base-sepolia
 */
describe('ACTP SDK - Base Sepolia Integration', () => {
  let requester: any;
  let provider: any;
  let client: ACTPClient;

  before(async function () {
    // Skip if not on Base Sepolia network
    const network = await ethers.provider.getNetwork();
    if (Number(network.chainId) !== 84532) {
      console.log('⚠️  Skipping integration tests - not on Base Sepolia network');
      console.log('   Run: npx hardhat test --network base-sepolia');
      this.skip();
      return;
    }

    const signers = await ethers.getSigners();
    if (signers.length < 2) {
      throw new Error('Need at least 2 signers for integration tests (set PRIVATE_KEY and PROVIDER_PRIVATE_KEY in .env)');
    }

    requester = signers[0];
    provider = signers[1];

    console.log('🔗 Connected to Base Sepolia');
    console.log('   Requester:', requester.address);
    console.log('   Provider:', provider.address);
    console.log('   ACTPKernel:', BASE_SEPOLIA.contracts.actpKernel);
    console.log('   EscrowVault:', BASE_SEPOLIA.contracts.escrowVault);
    console.log('   MockUSDC:', BASE_SEPOLIA.contracts.usdc);

    // Create SDK client connected to deployed contracts
    client = await ACTPClient.create({
      network: 'base-sepolia',
      signer: requester,
      provider: requester.provider
    });

    // Mint test USDC (MockUSDC has open minting for testnet)
    const usdcContract = new ethers.Contract(
      BASE_SEPOLIA.contracts.usdc,
      ['function mint(address to, uint256 amount) external'],
      requester
    );

    const mintAmount = ethers.parseUnits('1000', 6); // 1000 USDC
    console.log('💰 Minting test USDC...');
    const mintTx = await usdcContract.mint(requester.address, mintAmount);
    await mintTx.wait();
    console.log('   Minted:', ethers.formatUnits(mintAmount, 6), 'USDC');
  });

  it('runs full transaction lifecycle on deployed contracts', async function () {
    this.timeout(180000); // 3 minutes for network operations

    const amount = ethers.parseUnits('100', 6); // 100 USDC
    // Unique metadata per test run to avoid txId collisions
    const metadata = ethers.id('test-1-lifecycle-' + Date.now());

    console.log('\n📝 Creating transaction...');
    const txId = await client.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR,
      metadata
    });
    console.log('   Transaction ID:', txId);

    console.log('🔒 Preparing escrow linkage...');
    // Step 1: Approve USDC to EscrowVault (NOT to Kernel!)
    await client.escrow.approveToken(BASE_SEPOLIA.contracts.usdc, amount);
    console.log('   ✅ USDC approved to EscrowVault');

    // Step 2: Generate unique escrow ID
    const escrowId = ethers.id(`test-escrow-${Date.now()}`);
    console.log('   Escrow ID:', escrowId);

    // Step 3: Link escrow via Kernel (creates escrow + auto-transitions to COMMITTED)
    console.log('🔗 Linking escrow (Kernel calls EscrowVault.createEscrow internally)...');
    await client.kernel.linkEscrow(txId, client.escrow.getAddress(), escrowId);
    console.log('   ✅ Escrow created and linked');

    // Verify linkEscrow auto-transitioned to COMMITTED (per AIP-3 spec, ACTPKernel.sol line 270)
    let tx = await client.kernel.getTransaction(txId);
    expect(Number(tx.state)).to.equal(State.COMMITTED);
    console.log('   ✅ linkEscrow() auto-transitioned to COMMITTED');

    console.log('⚡ Transitioning COMMITTED → IN_PROGRESS (provider action)...');
    // Create provider client to transition to IN_PROGRESS (only provider can do this)
    const providerClient = await ACTPClient.create({
      network: 'base-sepolia',
      signer: provider,
      provider: provider.provider
    });
    await providerClient.kernel.transitionState(txId, State.IN_PROGRESS);
    console.log('   → IN_PROGRESS');

    console.log('📦 Generating delivery proof (provider action)...');
    const proof = providerClient.proofGenerator.generateDeliveryProof({
      txId,
      deliverable: 'Integration test deliverable on Base Sepolia',
      metadata: { description: 'hardhat-integration-test', network: 'base-sepolia' }
    });
    const encodedProof = providerClient.proofGenerator.encodeProof(proof);

    await providerClient.kernel.transitionState(txId, State.DELIVERED, encodedProof);
    console.log('   → DELIVERED');

    console.log('💸 Releasing escrow...');
    await client.kernel.releaseEscrow(txId);
    console.log('   → SETTLED');

    await client.escrow.releaseEscrow(escrowId, [provider.address], [amount]);

    // Verify provider received funds
    const usdcContract = new ethers.Contract(
      BASE_SEPOLIA.contracts.usdc,
      ['function balanceOf(address) view returns (uint256)'],
      requester.provider
    );

    const providerBalance = await usdcContract.balanceOf(provider.address);
    console.log('✅ Provider received:', ethers.formatUnits(providerBalance, 6), 'USDC');

    expect(providerBalance >= amount).to.be.true;
  });

  it('handles USDC approvals correctly on deployed contracts', async function () {
    this.timeout(180000);

    const amount1 = ethers.parseUnits('50', 6);
    const amount2 = ethers.parseUnits('80', 6);
    const timestamp = Date.now();

    console.log('\n📝 Creating first transaction (50 USDC)...');
    const txId1 = await client.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount: amount1,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR,
      metadata: ethers.id('test-2-approval-1-' + timestamp)
    });

    // Approve and link escrow for transaction 1
    await client.escrow.approveToken(BASE_SEPOLIA.contracts.usdc, amount1);
    const escrowId1 = ethers.id(`test-escrow-1-${timestamp}`);
    await client.kernel.linkEscrow(txId1, client.escrow.getAddress(), escrowId1);
    console.log('   ✅ Transaction 1 escrow linked');

    console.log('📝 Creating second transaction (80 USDC)...');
    const txId2 = await client.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount: amount2,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR,
      metadata: ethers.id('test-2-approval-2-' + timestamp)
    });

    // Approve and link escrow for transaction 2
    await client.escrow.approveToken(BASE_SEPOLIA.contracts.usdc, amount2);
    const escrowId2 = ethers.id(`test-escrow-2-${timestamp}`);
    await client.kernel.linkEscrow(txId2, client.escrow.getAddress(), escrowId2);
    console.log('   ✅ Transaction 2 escrow linked');

    // Check allowance increased correctly
    const usdcContract = new ethers.Contract(
      BASE_SEPOLIA.contracts.usdc,
      ['function allowance(address owner, address spender) view returns (uint256)'],
      requester.provider
    );

    const allowance: bigint = await usdcContract.allowance(
      requester.address,
      client.escrow.getAddress()
    );

    console.log('✅ USDC allowance:', ethers.formatUnits(allowance, 6), 'USDC');
    expect(allowance >= amount2).to.be.true;
  });

  it('signs typed delivery proofs with correct EIP-712 format', async () => {
    const proofGenerator = new ProofGenerator();

    // This test doesn't need network interaction
    const testClient = await ACTPClient.create({
      network: 'base-sepolia',
      signer: requester,
      provider: requester.provider,
      contracts: {
        actpKernel: ethers.ZeroAddress,
        escrowVault: ethers.ZeroAddress,
        usdc: ethers.ZeroAddress
      }
    });

    const txId = ethers.hexlify(ethers.randomBytes(32));
    const proof = proofGenerator.generateDeliveryProof({
      txId,
      deliverable: 'EIP-712 typed proof test',
      metadata: { mimeType: 'text/plain' }
    });

    console.log('\n✍️  Signing delivery proof...');
    const signature = await testClient.messageSigner.signGeneratedDeliveryProof(proof);
    const typedData = deliveryProofDataFromProof(proof);

    const network = await requester.provider.getNetwork();
    const recovered = ethers.verifyTypedData(
      {
        name: 'ACTP',
        version: '1.0',
        chainId: Number(network.chainId),
        verifyingContract: ethers.ZeroAddress
      },
      DeliveryProofTypes,
      typedData,
      signature
    );

    console.log('✅ Signature verified, signer:', recovered);
    expect(recovered.toLowerCase()).to.equal(requester.address.toLowerCase());
  });
});
