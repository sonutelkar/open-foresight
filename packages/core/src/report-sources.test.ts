import { describe, expect, it } from 'vitest';
import { isPublicHttpsUrl, onAllowList, reportSources } from './report-sources.js';

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
  it('accepts a public https page for a label source and rejects local, private, IP and non-https addresses', () => {
    for (const ok of ['https://investors.example.com/annual-report.pdf', 'https://www.sec.gov/Archives/x.htm', 'https://news.example.co.uk:443/a']) expect(isPublicHttpsUrl(ok)).toBe(true);
    for (const bad of ['http://example.com/a', 'https://localhost/a', 'https://intranet/a', 'https://printer.local/a', 'https://db.internal/a', 'https://10.0.0.8/a', 'https://0x7f.0.0.1/a', 'https://2130706433/a', 'https://[::1]/a', 'https://user:pw@example.com/a', 'https://example.com:8443/a', 'ftp://example.com/a', 'not a url']) expect(isPublicHttpsUrl(bad)).toBe(false);
  });
});
