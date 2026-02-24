import { TestJob } from '../types';

export const automationJob: TestJob = {
  serviceType: 'automation',
  title: 'Simple 3-step workflow to automate',
  input: {
    workflow: {
      name: 'Daily report generation',
      steps: [
        {
          step: 1,
          action: 'Fetch sales data from API endpoint',
          source: 'https://api.example.com/sales/daily',
        },
        {
          step: 2,
          action: 'Generate summary with totals, averages, and top 3 products',
          format: 'markdown',
        },
        {
          step: 3,
          action: 'Send report via email to team@example.com',
          subject: 'Daily Sales Report — {{date}}',
        },
      ],
    },
    trigger: 'daily at 09:00 UTC',
  },
  expectedDeliverable: 'Automation script or configuration for the workflow',
};
