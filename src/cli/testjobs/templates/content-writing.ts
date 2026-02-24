import { TestJob } from '../types';

export const contentWritingJob: TestJob = {
  serviceType: 'content-writing',
  title: 'Blog post brief on AI agent economy',
  input: {
    topic: 'How AI agents are creating a new service economy',
    tone: 'professional but accessible',
    length: '500 words',
    audience: 'Technical founders and developers',
    key_points: [
      'Agents can now earn and pay autonomously',
      'Escrow-based trust replaces reputation guessing',
      'The shift from APIs to agent-to-agent commerce',
    ],
  },
  expectedDeliverable: 'Blog post draft matching the brief',
};
