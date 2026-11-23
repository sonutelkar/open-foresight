import { describe, expect, it } from 'vitest';
import { decideExposure, exposureInstructions, exposureOptions } from './exposure.js';

const ans = (choice: string, p: Record<string, number>) => ({ choice, probabilities: { core: 0, partial: 0, none: 0, cannot_tell: 0, ...p } });

describe('decideExposure', () => {
  it('calls a name outside the theme only on a confident none', () => {
    expect(decideExposure(ans('none', { none: 0.97 }))).toBe('none');
    expect(decideExposure(ans('none', { none: 0.95 }))).toBe('none');
    expect(decideExposure(ans('none', { none: 0.94 }))).toBe('unknown');
  });
  it('leaves core and partial names to normal scoring', () => {
    expect(decideExposure(ans('core', { core: 0.8 }))).toBe('exposed');
    expect(decideExposure(ans('partial', { partial: 0.5 }))).toBe('exposed');
  });
  it('keeps cannot_tell, an unknown option and a missing answer unknown, never zero', () => {
    expect(decideExposure(ans('cannot_tell', { cannot_tell: 0.99 }))).toBe('unknown');
    expect(decideExposure(ans('other', { none: 0.99 }))).toBe('unknown');
    expect(decideExposure(undefined)).toBe('unknown');
  });
  it('offers the options a Choice needs and puts the theme in the question', () => {
    expect(Object.keys(exposureOptions)).toEqual(['core', 'partial', 'none', 'cannot_tell']);
    expect(exposureInstructions('Smart energy')).toContain('Theme: Smart energy');
  });
});
