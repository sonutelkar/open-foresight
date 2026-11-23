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

/**
 * The URL policy for the web sources a release label cites, where no per-company allow-list exists: at most `maxUrls` URLs per label,
 * pages of at most `maxBytes`, and the HTML and PDF types the fetcher reads.
 */
export const labelSourcePolicy = { maxUrls: 3, maxBytes: 10 * 1024 * 1024 } as const;
const privateSuffixes = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home.arpa'];

/**
 * True for an https URL on the default port with no user info and a public host name: not an IP address, not a single label, and not under a
 * local or private suffix. It does not resolve the name, so a public name that points at a private address passes this check.
 */
export function isPublicHttpsUrl(url: string | URL): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port !== '' && parsed.port !== '443')) return false;
  const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (!host.includes('.') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return false;
  return !privateSuffixes.some(s => host === s || host.endsWith(`.${s}`));
}
