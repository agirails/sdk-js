/**
 * Test Job Selector
 *
 * Matches agent service types to realistic test jobs.
 * Falls back to generic job for unknown service types.
 *
 * @module cli/testjobs
 */

import { TestJob } from './types';
import { codeReviewJob } from './templates/code-review';
import { translationJob } from './templates/translation';
import { securityAuditJob } from './templates/security-audit';
import { dataAnalysisJob } from './templates/data-analysis';
import { contentWritingJob } from './templates/content-writing';
import { testingJob } from './templates/testing';
import { automationJob } from './templates/automation';
import { genericJob } from './templates/generic';

export { TestJob } from './types';

const TEMPLATE_MAP: Record<string, TestJob> = {
  'code-review': codeReviewJob,
  'translation': translationJob,
  'security-audit': securityAuditJob,
  'data-analysis': dataAnalysisJob,
  'content-writing': contentWritingJob,
  'testing': testingJob,
  'automation': automationJob,
};

/**
 * Select a test job matching the agent's first declared service type.
 *
 * @param services - Agent's declared service types
 * @returns Matching test job (or generic fallback)
 */
export function selectTestJob(services: string[]): TestJob {
  for (const service of services) {
    const normalized = service.toLowerCase().trim();
    if (TEMPLATE_MAP[normalized]) {
      return TEMPLATE_MAP[normalized];
    }
  }
  return genericJob;
}
