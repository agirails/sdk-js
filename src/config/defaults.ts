/**
 * Convention-Over-Config Defaults for {slug}.md
 *
 * When a field is missing or commented out in the YAML frontmatter,
 * these defaults are applied. Developer uncomments a line to override.
 *
 * @module config/defaults
 */

// ============================================================================
// Default Values
// ============================================================================

export const V4_DEFAULTS = {
  pricing: {
    currency: 'USDC' as const,
    unit: 'job',
    negotiable: false,
  },
  network: 'mock' as const,
  sla: {
    response: '2h',
    delivery: '24h',
    concurrency: 10,
    dispute_window: '48h',
  },
  payment: {
    modes: ['actp'],
  },
} as const;

// ============================================================================
// Validation Constraints
// ============================================================================

export const V4_CONSTRAINTS = {
  /** Minimum price in USDC */
  MIN_PRICE: 0.05,
  /** Maximum slug length */
  MAX_SLUG_LENGTH: 64,
  /** Allowed characters in slug */
  SLUG_PATTERN: /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/,
  /** Known service types (for test job matching) */
  KNOWN_SERVICES: [
    'code-review',
    'translation',
    'security-audit',
    'data-analysis',
    'content-writing',
    'testing',
    'automation',
  ] as const,
  /** Valid network values */
  VALID_NETWORKS: ['mock', 'testnet', 'mainnet'] as const,
  /** Valid payment modes */
  VALID_PAYMENT_MODES: ['actp', 'x402'] as const,
  /** Heading that splits description from howToRequest */
  HOW_TO_REQUEST_HEADING: '## How to Request This Service',
} as const;

// ============================================================================
// Display Fee Calculation (cosmetic only — MockRuntime pays full amount)
// ============================================================================

/** Platform fee: 1% with $0.05 minimum (in USDC wei, 6 decimals) */
const MIN_FEE_WEI = 50_000n; // $0.05
const FEE_BPS = 100n; // 1%

/**
 * Compute display fee for receipt rendering.
 * This is cosmetic — MockRuntime settles the full amount to provider.
 *
 * @param amountWei - Transaction amount in USDC wei (6 decimals)
 * @returns Fee in USDC wei
 */
export function computeDisplayFee(amountWei: bigint): bigint {
  const percentFee = (amountWei * FEE_BPS) / 10_000n;
  return percentFee > MIN_FEE_WEI ? percentFee : MIN_FEE_WEI;
}
