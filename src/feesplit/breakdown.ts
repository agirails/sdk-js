/**
 * What each party received from an escrow, joined from kernel and vault events.
 *
 * The kernel's EscrowReleased and EscrowRefunded amounts are what the kernel passed to the vault,
 * before the vault's fees. In a FeeSplitVault the provider and the requester can receive less: the
 * truth is the vault's IntegratorFeeSplit and RefundFeeSplit, joined on the escrow and required to
 * carry the same kernel amount.
 *
 * @module feesplit/breakdown
 */

/** One kernel payment out of the escrow, in log order. */
export interface KernelPayout {
  kind: 'released' | 'refunded' | 'mediator';
  amount: bigint;
}

/** One vault fee split, in log order. */
export interface VaultSplit {
  kind: 'released' | 'refunded';
  /** The amount the kernel passed in. */
  kernelAmount: bigint;
  /** Transferred to the provider or to the requester. */
  received: bigint;
  integratorAmount: bigint;
  integratorCredited: boolean;
  protocolFee: bigint;
  protocolCredited: boolean;
}

/** One movement of the breakdown; amounts in USDC wei. */
export interface PayoutMovement {
  kind: 'released' | 'refunded' | 'mediator';
  /** Kernel event amount: before the vault's fees. */
  kernelAmount: string;
  /** What the provider, the requester or the mediator received. */
  received: string;
  integratorPaid: string;
  integratorCredited: string;
  vaultProtocolFee: string;
  protocolCredited: string;
}

/** Per movement and in total: who received what from one escrow. */
export interface PayoutBreakdown {
  txId: string;
  /** The vault the transaction is linked to. */
  vault: string;
  movements: PayoutMovement[];
  totals: {
    providerReceived: string;
    requesterReceived: string;
    mediatorReceived: string;
    /** Charged by the kernel on the provider side, including its archive share. */
    kernelFee: string;
    /** Refund-side protocol fee taken by the vault, paid or credited. */
    vaultProtocolFee: string;
    integratorPaid: string;
    integratorCredited: string;
    protocolCredited: string;
  };
}

function movementOf(payout: KernelPayout, split: VaultSplit | undefined): PayoutMovement {
  const paid = (amount: bigint, credited: boolean): string => (credited ? '0' : amount.toString());
  const owed = (amount: bigint, credited: boolean): string => (credited ? amount.toString() : '0');
  return {
    kind: payout.kind,
    kernelAmount: payout.amount.toString(),
    received: (split ? split.received : payout.amount).toString(),
    integratorPaid: split ? paid(split.integratorAmount, split.integratorCredited) : '0',
    integratorCredited: split ? owed(split.integratorAmount, split.integratorCredited) : '0',
    vaultProtocolFee: split ? split.protocolFee.toString() : '0',
    protocolCredited: split ? owed(split.protocolFee, split.protocolCredited) : '0',
  };
}

/**
 * Join kernel payments with the vault's fee splits.
 *
 * @param deposit - the escrow amount
 * @param principal - what the kernel still holds as participant principal (0 when terminal)
 * @throws Error when a vault split matches no kernel payment of the same kind and amount
 */
export function joinPayoutBreakdown(input: {
  txId: string;
  vault: string;
  deposit: bigint;
  principal: bigint;
  kernel: readonly KernelPayout[];
  splits: readonly VaultSplit[];
}): PayoutBreakdown {
  const pending = [...input.splits];
  const movements = input.kernel.map(payout => {
    const index = pending.findIndex(split => split.kind === payout.kind && split.kernelAmount === payout.amount);
    return movementOf(payout, index < 0 ? undefined : pending.splice(index, 1)[0]);
  });
  if (pending.length > 0) {
    throw new Error(`Vault fee split of ${input.txId} matches no kernel payment of the same amount`);
  }
  const sum = (kind: PayoutMovement['kind'] | undefined, field: keyof Omit<PayoutMovement, 'kind'>): bigint =>
    movements.filter(m => kind === undefined || m.kind === kind).reduce((total, m) => total + BigInt(m[field]), 0n);
  const paidOut = sum(undefined, 'kernelAmount');
  return {
    txId: input.txId,
    vault: input.vault,
    movements,
    totals: {
      providerReceived: sum('released', 'received').toString(),
      requesterReceived: sum('refunded', 'received').toString(),
      mediatorReceived: sum('mediator', 'received').toString(),
      kernelFee: (input.deposit - paidOut - input.principal).toString(),
      vaultProtocolFee: sum(undefined, 'vaultProtocolFee').toString(),
      integratorPaid: sum(undefined, 'integratorPaid').toString(),
      integratorCredited: sum(undefined, 'integratorCredited').toString(),
      protocolCredited: sum(undefined, 'protocolCredited').toString(),
    },
  };
}
