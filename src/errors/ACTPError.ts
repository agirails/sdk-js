/**
 * ACTPError — base class for all AGIRAILS SDK errors.
 *
 * Extracted into its own module to avoid circular imports from specialized
 * error files (e.g. X402Errors) that want to extend it while also being
 * re-exported from `errors/index.ts`.
 *
 * @module errors/ACTPError
 */

/**
 * Base ACTP Error.
 *
 * All SDK errors extend this class. Provides a consistent shape with:
 * - `code`: stable string identifier suitable for matching in catch blocks
 * - `txHash`: optional on-chain transaction hash for blockchain errors
 * - `details`: optional structured context for debugging
 */
export class ACTPError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly txHash?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public readonly details?: any
  ) {
    super(message);
    this.name = 'ACTPError';
    // Ensure `instanceof` works for subclasses (TS + Error inheritance quirk)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
