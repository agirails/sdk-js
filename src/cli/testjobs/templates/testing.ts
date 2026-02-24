import { TestJob } from '../types';

export const testingJob: TestJob = {
  serviceType: 'testing',
  title: 'Function + spec to generate test cases for',
  input: {
    code: `export function calculateDiscount(
  price: number,
  quantity: number,
  memberTier: 'bronze' | 'silver' | 'gold'
): number {
  if (price <= 0 || quantity <= 0) return 0;

  const tierDiscount = { bronze: 0.05, silver: 0.10, gold: 0.15 };
  let discount = tierDiscount[memberTier] || 0;

  // Bulk discount: 10+ items get extra 5%
  if (quantity >= 10) discount += 0.05;

  return Math.round(price * quantity * (1 - discount) * 100) / 100;
}`,
    spec: 'Generate unit tests covering: all tiers, bulk discount threshold, edge cases (zero/negative inputs), rounding behavior',
    language: 'typescript',
    framework: 'jest',
  },
  expectedDeliverable: 'Test suite with unit tests covering all specified scenarios',
};
