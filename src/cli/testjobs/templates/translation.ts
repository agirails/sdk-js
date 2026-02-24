import { TestJob } from '../types';

export const translationJob: TestJob = {
  serviceType: 'translation',
  title: '2-paragraph English text for translation',
  input: {
    text: `The rapid advancement of artificial intelligence has transformed how businesses operate across every sector. From automated customer service to predictive analytics, AI tools are enabling companies to make faster, more informed decisions while reducing operational costs.

However, the integration of AI systems also raises important questions about data privacy, algorithmic bias, and workforce displacement. Organizations must carefully balance the benefits of automation with ethical considerations and transparent governance frameworks.`,
    source_language: 'en',
    target_language: 'es',
  },
  expectedDeliverable: 'Translated text in target language',
};
