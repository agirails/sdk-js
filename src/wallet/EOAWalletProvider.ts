/**
 * EOAWalletProvider — Tier 2 (BYOW) wallet implementation.
 *
 * Wraps an ethers.Wallet for traditional EOA signing.
 * sendBatchTransaction() executes calls sequentially (no atomic batching).
 * This is the backward-compatible path for agents that don't register.
 *
 * @module wallet/EOAWalletProvider
 */

import { ethers } from 'ethers';
import {
  IWalletProvider,
  TransactionRequest,
  TransactionReceipt,
  WalletInfo,
} from './IWalletProvider';

export class EOAWalletProvider implements IWalletProvider {
  private readonly wallet: ethers.Wallet;
  private readonly chainId: number;

  constructor(wallet: ethers.Wallet, chainId: number) {
    this.wallet = wallet;
    this.chainId = chainId;
  }

  getAddress(): string {
    return this.wallet.address;
  }

  async sendTransaction(tx: TransactionRequest): Promise<TransactionReceipt> {
    const response = await this.wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ? BigInt(tx.value) : 0n,
    });
    const receipt = await response.wait();
    return {
      hash: receipt!.hash,
      success: receipt!.status === 1,
    };
  }

  async sendBatchTransaction(txs: TransactionRequest[]): Promise<TransactionReceipt> {
    if (txs.length === 0) {
      throw new Error('sendBatchTransaction requires at least one transaction');
    }

    let lastReceipt: TransactionReceipt | undefined;
    for (const tx of txs) {
      lastReceipt = await this.sendTransaction(tx);
      if (!lastReceipt.success) {
        return lastReceipt; // Fail fast
      }
    }
    return lastReceipt!;
  }

  getWalletInfo(): WalletInfo {
    return {
      address: this.wallet.address,
      tier: 'eoa',
      supportsBatching: false,
      gasSponsored: false,
      chainId: this.chainId,
    };
  }
}
