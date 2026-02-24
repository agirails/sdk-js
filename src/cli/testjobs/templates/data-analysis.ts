import { TestJob } from '../types';

export const dataAnalysisJob: TestJob = {
  serviceType: 'data-analysis',
  title: 'CSV dataset with 20 rows for analysis',
  input: {
    data: `date,product,revenue,units,region
2026-01-01,Widget A,1200,24,North
2026-01-02,Widget B,890,15,South
2026-01-03,Widget A,1450,29,North
2026-01-04,Widget C,2100,42,East
2026-01-05,Widget B,670,11,West
2026-01-06,Widget A,1380,28,South
2026-01-07,Widget C,1950,39,North
2026-01-08,Widget B,1100,18,East
2026-01-09,Widget A,1600,32,West
2026-01-10,Widget C,2300,46,South
2026-01-11,Widget A,1150,23,East
2026-01-12,Widget B,940,16,North
2026-01-13,Widget C,2050,41,West
2026-01-14,Widget A,1500,30,South
2026-01-15,Widget B,780,13,East
2026-01-16,Widget C,2200,44,North
2026-01-17,Widget A,1350,27,West
2026-01-18,Widget B,1020,17,South
2026-01-19,Widget C,1880,38,East
2026-01-20,Widget A,1700,34,North`,
    format: 'csv',
    task: 'Summarize revenue by product and region. Identify the top performer.',
  },
  expectedDeliverable: 'Analysis summary with revenue breakdown and insights',
};
