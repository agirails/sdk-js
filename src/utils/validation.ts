import { BigNumber, utils } from 'ethers';
import {
  InvalidAddressError,
  InvalidAmountError,
  ValidationError
} from '../errors';

/**
 * Input validation utilities
 */

/**
 * Validate Ethereum address
 */
export function validateAddress(address: string, fieldName: string = 'address'): void {
  if (!address || !utils.isAddress(address)) {
    throw new InvalidAddressError(address);
  }
  
  if (address === utils.getAddress('0x0000000000000000000000000000000000000000')) {
    throw new ValidationError(fieldName, 'Address cannot be zero address');
  }
}

/**
 * Validate amount (must be > 0)
 */
export function validateAmount(amount: BigNumber, _fieldName: string = 'amount'): void {
  // Handle null/undefined before calling toString()
  if (!amount) {
    throw new InvalidAmountError(String(amount)); // Convert safely to string
  }
  
  if (amount.lte(0)) {
    throw new InvalidAmountError(amount.toString());
  }
}

/**
 * Validate deadline (must be future timestamp)
 */
export function validateDeadline(deadline: number, fieldName: string = 'deadline'): void {
  const now = Math.floor(Date.now() / 1000);
  
  if (deadline <= now) {
    throw new ValidationError(
      fieldName,
      `Deadline must be in the future (now: ${now}, deadline: ${deadline})`
    );
  }
}

/**
 * Validate dispute window (max 30 days per spec)
 */
export function validateDisputeWindow(
  disputeWindow: number,
  fieldName: string = 'disputeWindow'
): void {
  const MAX_DISPUTE_WINDOW = 30 * 24 * 60 * 60; // 30 days in seconds
  
  if (disputeWindow < 0) {
    throw new ValidationError(fieldName, 'Dispute window cannot be negative');
  }
  
  if (disputeWindow > MAX_DISPUTE_WINDOW) {
    throw new ValidationError(
      fieldName,
      `Dispute window exceeds maximum (${MAX_DISPUTE_WINDOW}s = 30 days)`
    );
  }
}

/**
 * Validate transaction ID format
 */
export function validateTxId(txId: string, fieldName: string = 'txId'): void {
  if (!txId || !txId.match(/^0x[a-fA-F0-9]{64}$/)) {
    throw new ValidationError(fieldName, 'Invalid transaction ID format (expected bytes32)');
  }
}

