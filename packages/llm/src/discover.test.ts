import { describe, expect, it } from 'vitest';
import { createDiscoverer } from './discover.js';

const ok = (content: string, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ model: 'anthropic/claude-haiku-5.5', provider: 'Google', usage: { cost: 0.0076 }, choices: [{ message: { content, annotations: [{ type: 'url_citation', url_citation: { url: 'https://www.siemens.com/ar' } }, { type: 'other' }] } }], ...extra }), { status: 200 });
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as { provider: Record<string, unknown>; plugins: unknown[]; messages: Array<{ content: string }>; model: string };

describe('createDiscoverer', () => {
  it('asks for ZDR and no data collection with the web tool, and returns the text, cited URLs and cost', async () => {
    const seen: Array<ReturnType<typeof bodyOf>> = [];
    const d = createDiscoverer({ apiKey: 'k', fetch: async (_u, init) => { seen.push(bodyOf(init)); return ok('{"candidates":[]}'); } });
    const r = await d.discover('Find the Siemens annual report');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ model: 'anthropic/claude-haiku-5.5', plugins: [{ id: 'web', max_results: 5 }], provider: { zdr: true, data_collection: 'deny', allow_fallbacks: false } });
    expect(seen[0]!.messages[0]!.content).toBe('Find the Siemens annual report');
    expect(r).toMatchObject({ text: '{"candidates":[]}', citedUrls: ['https://www.siemens.com/ar'], zdr: true, cost: 0.0076, provider: 'Google' });
    expect(JSON.stringify(r.params)).not.toContain('Find the Siemens');
  });

  it('repeats without ZDR, warns once and says so when no provider honors ZDR', async () => {
    const seen: Array<ReturnType<typeof bodyOf>> = [];
    const warnings: string[] = [];
    const d = createDiscoverer({ apiKey: 'k', warn: m => warnings.push(m), fetch: async (_u, init) => {
      const b = bodyOf(init); seen.push(b);
      return b.provider.zdr ? new Response('{"error":{"message":"No endpoints found matching your data policy (Zero data retention)."}}', { status: 404 }) : ok('{"candidates":[]}');
    } });
    const r = await d.discover('x');
    expect(seen.map(b => b.provider.zdr)).toEqual([true, undefined]);
    expect(seen[1]!.provider).toMatchObject({ data_collection: 'deny', allow_fallbacks: false });
    expect(warnings).toHaveLength(1);
    expect(r.zdr).toBe(false);
  });

  it('throws any other failure and does not retry it', async () => {
    let calls = 0;
    const d = createDiscoverer({ apiKey: 'k', fetch: async () => { calls++; return new Response('upstream broke', { status: 500 }); } });
    await expect(d.discover('x')).rejects.toThrow('HTTP 500');
    expect(calls).toBe(1);
    await expect(createDiscoverer({ apiKey: 'k', fetch: async () => ok('{}') }).discover('  ')).rejects.toThrow('prompt');
    expect(() => createDiscoverer({ apiKey: ' ' })).toThrow('API key');
  });
});
