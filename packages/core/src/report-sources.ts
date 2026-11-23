/**
 * A company whose annual report is found on its own site, because the ESEF index and the SEC have none. Code owns this list.
 * `domains` is the allow-list for that company, and a fetched page must mention one of `mustMention`.
 */
export type ReportSource = { issuerKey: string; entityName: string; mustMention: readonly string[]; domains: readonly string[] };

export const reportSources: readonly ReportSource[] = [
  { issuerKey: 'lei:W38RGI023J3WT1HWRP32', entityName: 'Siemens AG', mustMention: ['Siemens'], domains: ['siemens.com'] },
  { issuerKey: 'lei:Q9MAIUP40P25UFBFG033', entityName: 'E.ON SE', mustMention: ['E.ON'], domains: ['eon.com'] },
  { issuerKey: 'lei:529900GB7KCA94ACC940', entityName: 'RWE AG', mustMention: ['RWE'], domains: ['rwe.com'] },
];

/** True when the URL is https and its host is a listed domain or a subdomain of one. */
export function onAllowList(url: string, domains: readonly string[]): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' && domains.some(d => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`));
}
