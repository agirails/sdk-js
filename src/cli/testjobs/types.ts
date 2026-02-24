/**
 * Test Job Types
 *
 * @module cli/testjobs/types
 */

export interface TestJob {
  /** Service type this job matches */
  serviceType: string;
  /** Human-readable description of the test job */
  title: string;
  /** Input payload to send to the agent */
  input: Record<string, unknown>;
  /** Expected deliverable description (for receipt display) */
  expectedDeliverable: string;
}
