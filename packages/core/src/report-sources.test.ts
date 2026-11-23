import { describe, expect, it } from 'vitest';
import { onAllowList, reportSources } from './report-sources.js';

describe('report sources', () => {
  it('lists well formed LEI keys with a domain and a mention each', () => {
    for (const s of reportSources) { expect(s.issuerKey).toMatch(/^lei:[A-Z0-9]{20}$/); expect(s.domains.length).toBeGreaterThan(0); expect(s.mustMention.length).toBeGreaterThan(0); }
    expect(new Set(reportSources.map(s => s.issuerKey)).size).toBe(reportSources.length);
  });
  it('allows a listed host or its subdomains over https only', () => {
    const d = ['siemens.com'];
    expect(onAllowList('https://assets.new.siemens.com/a.pdf', d)).toBe(true);
    expect(onAllowList('https://siemens.com/a.pdf', d)).toBe(true);
    for (const bad of ['http://siemens.com/a.pdf', 'https://evilsiemens.com/a.pdf', 'https://siemens.com.evil.org/a.pdf', 'https://example.com/siemens.com', 'not a url']) expect(onAllowList(bad, d)).toBe(false);
  });
});
