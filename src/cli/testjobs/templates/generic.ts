import { TestJob } from '../types';

export const genericJob: TestJob = {
  serviceType: 'generic',
  title: 'Generic test input',
  input: {
    task: 'Process this sample input and return a structured result',
    data: {
      items: ['alpha', 'beta', 'gamma'],
      priority: 'normal',
      format: 'json',
    },
  },
  expectedDeliverable: 'Processed result in requested format',
};
