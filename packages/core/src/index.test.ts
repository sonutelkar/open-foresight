import { expect, test } from 'vitest';
import { projectName } from './index.js';

test('exports the project name', () => {
  expect(projectName).toBe('Open Foresight');
});
