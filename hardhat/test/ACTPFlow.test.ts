import { expect } from 'chai';
import { ethers } from 'hardhat';
import { BigNumber } from 'ethers';
import { ACTPClient, State, ProofGenerator, deliveryProofDataFromProof, DeliveryProofTypes } from '../../src';
import { BASE_SEPOLIA } from '../../src/config/networks';

const ONE_HOUR = 3600;

/**
 * ACTP SDK Integration Tests - Base Sepolia Testnet
 *
 * These tests run against DEPLOYED contracts on Base Sepolia:
 * - ACTPKernel: 0xb5B002A73743765450d427e2F8a472C24FDABF9b
 * - EscrowVault: 0x67770791c83eA8e46D8a08E09682488ba584744f
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
    if (network.chainId !== 84532) {
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

    const mintAmount = ethers.utils.parseUnits('1000', 6); // 1000 USDC
    console.log('💰 Minting test USDC...');
    const mintTx = await usdcContract.mint(requester.address, mintAmount);
    await mintTx.wait();
    console.log('   Minted:', ethers.utils.formatUnits(mintAmount, 6), 'USDC');
  });

  it('runs full transaction lifecycle on deployed contracts', async function () {
    this.timeout(180000); // 3 minutes for network operations

    const amount = ethers.utils.parseUnits('100', 6); // 100 USDC

    console.log('\n📝 Creating transaction...');
    const txId = await client.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR,
      metadata: ethers.constants.HashZero
    });
    console.log('   Transaction ID:', txId);

    console.log('🔒 Creating escrow...');
    const escrowId = await client.escrow.createEscrow({
      kernelAddress: client.kernel.getAddress(),
      txId,
      token: BASE_SEPOLIA.contracts.usdc,
      amount,
      beneficiary: provider.address
    });
    console.log('   Escrow ID:', escrowId);

    console.log('🔗 Linking escrow to transaction...');
    await client.kernel.linkEscrow(txId, client.escrow.getAddress(), escrowId);

    console.log('⚡ Transitioning states...');
    await client.kernel.transitionState(txId, State.QUOTED);
    console.log('   → QUOTED');

    await client.kernel.transitionState(txId, State.COMMITTED);
    console.log('   → COMMITTED');

    await client.kernel.transitionState(txId, State.IN_PROGRESS);
    console.log('   → IN_PROGRESS');

    console.log('📦 Generating delivery proof...');
    const proof = client.proofGenerator.generateDeliveryProof({
      txId,
      deliverable: 'Integration test deliverable on Base Sepolia',
      metadata: { description: 'hardhat-integration-test', network: 'base-sepolia' }
    });
    const encodedProof = client.proofGenerator.encodeProof(proof);

    await client.kernel.transitionState(txId, State.DELIVERED, encodedProof);
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
    console.log('✅ Provider received:', ethers.utils.formatUnits(providerBalance, 6), 'USDC');

    expect(providerBalance.gte(amount)).to.be.true;
  });

  it('handles USDC approvals correctly on deployed contracts', async function () {
    this.timeout(180000);

    const amount1 = ethers.utils.parseUnits('50', 6);
    const amount2 = ethers.utils.parseUnits('80', 6);

    console.log('\n📝 Creating first transaction (50 USDC)...');
    const txId1 = await client.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount: amount1,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR
    });

    await client.escrow.createEscrow({
      kernelAddress: client.kernel.getAddress(),
      txId: txId1,
      token: BASE_SEPOLIA.contracts.usdc,
      amount: amount1,
      beneficiary: provider.address
    });

    console.log('📝 Creating second transaction (80 USDC)...');
    const txId2 = await client.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount: amount2,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR
    });

    await client.escrow.createEscrow({
      kernelAddress: client.kernel.getAddress(),
      txId: txId2,
      token: BASE_SEPOLIA.contracts.usdc,
      amount: amount2,
      beneficiary: provider.address
    });

    // Check allowance increased correctly
    const usdcContract = new ethers.Contract(
      BASE_SEPOLIA.contracts.usdc,
      ['function allowance(address owner, address spender) view returns (uint256)'],
      requester.provider
    );

    const allowance: BigNumber = await usdcContract.allowance(
      requester.address,
      client.escrow.getAddress()
    );

    console.log('✅ USDC allowance:', ethers.utils.formatUnits(allowance, 6), 'USDC');
    expect(allowance.gte(amount2)).to.be.true;
  });

  it('signs typed delivery proofs with correct EIP-712 format', async () => {
    const proofGenerator = new ProofGenerator();

    // This test doesn't need network interaction
    const testClient = await ACTPClient.create({
      network: 'base-sepolia',
      signer: requester,
      provider: requester.provider,
      contracts: {
        actpKernel: ethers.constants.AddressZero,
        escrowVault: ethers.constants.AddressZero,
        usdc: ethers.constants.AddressZero
      }
    });

    const txId = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const proof = proofGenerator.generateDeliveryProof({
      txId,
      deliverable: 'EIP-712 typed proof test',
      metadata: { mimeType: 'text/plain' }
    });

    console.log('\n✍️  Signing delivery proof...');
    const signature = await testClient.messageSigner.signGeneratedDeliveryProof(proof);
    const typedData = deliveryProofDataFromProof(proof);

    const recovered = ethers.utils.verifyTypedData(
      {
        name: 'ACTP',
        version: '1.0',
        chainId: await requester.getChainId(),
        verifyingContract: ethers.constants.AddressZero
      },
      DeliveryProofTypes,
      typedData,
      signature
    );

    console.log('✅ Signature verified, signer:', recovered);
    expect(recovered.toLowerCase()).to.equal(requester.address.toLowerCase());
  });
});
