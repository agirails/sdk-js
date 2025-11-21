import { expect } from 'chai';
import { ethers } from 'hardhat';
import { BigNumber } from 'ethers';
import { ACTPClient, State, ProofGenerator, deliveryProofDataFromProof, DeliveryProofTypes } from '../../src';

const ONE_HOUR = 3600;

async function buildClient(
  signer: any,
  kernel: string,
  escrow: string,
  usdc: string
): Promise<ACTPClient> {
  return await ACTPClient.create({
    network: 'base-sepolia',
    signer,
    provider: signer.provider,
    contracts: {
      actpKernel: kernel,
      escrowVault: escrow,
      usdc
    }
  });
}

describe('ACTP SDK Hardhat Integration', () => {
  it('runs full lifecycle including escrow release', async () => {
    const [deployer, requester, provider] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory('MockUSDC');
    const usdc = await MockUSDC.deploy();
    await usdc.deployed();

    const MockEscrow = await ethers.getContractFactory('MockEscrowVault');
    const escrow = await MockEscrow.deploy();
    await escrow.deployed();

    const MockKernel = await ethers.getContractFactory('MockACTPKernel');
    const kernel = await MockKernel.deploy();
    await kernel.deployed();

    const amount = ethers.utils.parseUnits('250', 6);
    await usdc.mint(requester.address, amount);

    const client = await buildClient(requester, kernel.address, escrow.address, usdc.address);

    const txId = await client.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR,
      metadata: ethers.constants.HashZero
    });

    const escrowId = await client.escrow.createEscrow({
      kernelAddress: client.kernel.getAddress(),
      txId,
      token: usdc.address,
      amount,
      beneficiary: provider.address
    });

    await client.kernel.linkEscrow(txId, client.escrow.getAddress(), escrowId);

    await client.kernel.transitionState(txId, State.QUOTED);
    await client.kernel.transitionState(txId, State.COMMITTED);
    await client.kernel.transitionState(txId, State.IN_PROGRESS);

    const proof = client.proofGenerator.generateDeliveryProof({
      txId,
      deliverable: 'Hardhat rendered deliverable',
      metadata: { description: 'unit-test' }
    });
    const encodedProof = client.proofGenerator.encodeProof(proof);
    await client.kernel.transitionState(txId, State.DELIVERED, encodedProof);

    await client.kernel.releaseEscrow(txId);

    await client.escrow.releaseEscrow(escrowId, [provider.address], [amount]);

    expect(await usdc.balanceOf(provider.address)).to.equal(amount);
  });

  it('resets USDC approvals before increasing allowance', async () => {
    const [_, requester, provider] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory('MockUSDC');
    const usdc = await MockUSDC.deploy();
    await usdc.deployed();

    const MockEscrow = await ethers.getContractFactory('MockEscrowVault');
    const escrow = await MockEscrow.deploy();
    await escrow.deployed();

    const MockKernel = await ethers.getContractFactory('MockACTPKernel');
    const kernel = await MockKernel.deploy();
    await kernel.deployed();

    const amount = ethers.utils.parseUnits('50', 6);
    const largerAmount = ethers.utils.parseUnits('80', 6);
    await usdc.mint(requester.address, ethers.utils.parseUnits('200', 6));

    const client = await buildClient(requester, kernel.address, escrow.address, usdc.address);

    const txId1 = await client.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR
    });

    await client.escrow.createEscrow({
      kernelAddress: client.kernel.getAddress(),
      txId: txId1,
      token: usdc.address,
      amount,
      beneficiary: provider.address
    });

    const txId2 = await client.kernel.createTransaction({
      provider: provider.address,
      requester: requester.address,
      amount: largerAmount,
      deadline: Math.floor(Date.now() / 1000) + ONE_HOUR,
      disputeWindow: ONE_HOUR
    });

    await client.escrow.createEscrow({
      kernelAddress: client.kernel.getAddress(),
      txId: txId2,
      token: usdc.address,
      amount: largerAmount,
      beneficiary: provider.address
    });

    const allowance: BigNumber = await usdc.allowance(requester.address, client.escrow.getAddress());
    expect(allowance).to.equal(largerAmount);
  });

  it('signs typed delivery proofs that match generated proof data', async () => {
    const [requester] = await ethers.getSigners();
    const proofGenerator = new ProofGenerator();
    const client = await ACTPClient.create({
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
      deliverable: 'Typed proof',
      metadata: { mimeType: 'text/plain' }
    });

    const signature = await client.messageSigner.signGeneratedDeliveryProof(proof);
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

    expect(recovered.toLowerCase()).to.equal(requester.address.toLowerCase());
  });
});
