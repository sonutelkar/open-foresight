import type { ModelConfig } from '@open-foresight/llm';

export const models: ModelConfig[] = [
  { role: 'designer', model: 'anthropic/claude-opus-5.5' },
  { role: 'analyst', model: 'openai/gpt-6-luna' },
];

// Decision models use a separate structured-decision endpoint.
export const decisionModels = [{ role: 'jev-evaluation', model: 'typesafe/jev-1.14' }] as const;
