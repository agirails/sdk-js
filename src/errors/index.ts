import { BigNumber } from 'ethers';
import { State } from '../types';

/**
 * Base ACTP Error
 */
export class ACTPError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly txHash?: string,
    public readonly details?: any
  ) {
    super(message);
    this.name = 'ACTPError';
    Object.setPrototypeOf(this, ACTPError.prototype);
  }
}

/**
 * Transaction Errors
 */
export class InsufficientFundsError extends ACTPError {
  constructor(required: BigNumber, available: BigNumber) {
    super(
      `Insufficient funds: need ${required.toString()} wei, have ${available.toString()} wei`,
      'INSUFFICIENT_FUNDS',
      undefined,
      { required: required.toString(), available: available.toString() }
    );
    this.name = 'InsufficientFundsError';
  }
}

export class TransactionNotFoundError extends ACTPError {
  constructor(txId: string) {
    super(`Transaction ${txId} not found`, 'TRANSACTION_NOT_FOUND', undefined, { txId });
    this.name = 'TransactionNotFoundError';
  }
}

export class DeadlineExpiredError extends ACTPError {
  constructor(txId: string, deadline: number) {
    super(
      `Transaction ${txId} deadline expired at ${new Date(deadline * 1000).toISOString()}`,
      'DEADLINE_EXPIRED',
      undefined,
      { txId, deadline }
    );
    this.name = 'DeadlineExpiredError';
  }
}

/**
 * State Machine Errors
 */
export class InvalidStateTransitionError extends ACTPError {
  constructor(from: State, to: State, validTransitions: string[]) {
    super(
      `Invalid state transition: ${State[from]} → ${State[to]}. ` +
        `Valid transitions: ${validTransitions.join(', ') || 'none (terminal state)'}`,
      'INVALID_STATE_TRANSITION',
      undefined,
      { from: State[from], to: State[to], validTransitions }
    );
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Signature Errors
 */
export class SignatureVerificationError extends ACTPError {
  constructor(expectedSigner: string, recoveredSigner: string) {
    super(
      `Signature verification failed. Expected ${expectedSigner}, got ${recoveredSigner}`,
      'SIGNATURE_VERIFICATION_FAILED',
      undefined,
      { expectedSigner, recoveredSigner }
    );
    this.name = 'SignatureVerificationError';
  }
}

/**
 * Blockchain Errors
 */
export class TransactionRevertedError extends ACTPError {
  constructor(txHash: string, reason?: string) {
    super(
      `Transaction reverted: ${reason || 'Unknown reason'}`,
      'TRANSACTION_REVERTED',
      txHash,
      { reason }
    );
    this.name = 'TransactionRevertedError';
  }
}

export class NetworkError extends ACTPError {
  constructor(network: string, message: string) {
    super(`Network error on ${network}: ${message}`, 'NETWORK_ERROR', undefined, { network });
    this.name = 'NetworkError';
  }
}

/**
 * Validation Errors
 */
export class ValidationError extends ACTPError {
  constructor(field: string, message: string) {
    super(`Validation error for ${field}: ${message}`, 'VALIDATION_ERROR', undefined, { field });
    this.name = 'ValidationError';
  }
}

export class InvalidAddressError extends ValidationError {
  constructor(address: string) {
    super('address', `Invalid Ethereum address: ${address}`);
    this.name = 'InvalidAddressError';
  }
}

export class InvalidAmountError extends ValidationError {
  constructor(amount: string) {
    super('amount', `Invalid amount: ${amount} (must be > 0)`);
    this.name = 'InvalidAmountError';
  }
}


