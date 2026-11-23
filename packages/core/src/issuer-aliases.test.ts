import { describe, expect, it } from 'vitest';
import { annualForms, isIssuerKey, issuerAliases } from './issuer-aliases.js';

describe('issuer aliases', () => {
  it('names well formed issuer keys, one entry per symbol and key', () => {
    for (const a of issuerAliases) { expect(isIssuerKey(a.issuerKey)).toBe(true); expect(a.note.length).toBeGreaterThan(10); }
    expect(new Set(issuerAliases.map(a => `${a.symbol}|${a.issuerKey}`)).size).toBe(issuerAliases.length);
  });
  it('rejects malformed keys', () => {
    for (const bad of ['cik:34088', 'CIK:0000034088', 'lei:short', 'sec:0000034088', '']) expect(isIssuerKey(bad)).toBe(false);
  });
  it('lists the annual forms of US and foreign private issuers', () => { expect([...annualForms]).toEqual(['10-K', '20-F', '40-F']); });
});
