import { TestJob } from '../types';

export const codeReviewJob: TestJob = {
  serviceType: 'code-review',
  title: 'TypeScript file with 3 planted issues',
  input: {
    code: `export function processPayment(amount: string, userId: any) {
  // BUG 1: No input validation on amount
  const parsed = parseFloat(amount);

  // BUG 2: SQL injection vulnerability
  const query = \`SELECT * FROM users WHERE id = '\${userId}'\`;

  // BUG 3: Floating point comparison
  if (parsed == 0.1 + 0.2) {
    return "exact match";
  }

  return { amount: parsed, query };
}`,
    language: 'typescript',
    focus: 'all',
  },
  expectedDeliverable: 'Code review with severity ratings and fix suggestions',
};
