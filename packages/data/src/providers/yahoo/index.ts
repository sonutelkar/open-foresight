import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { marketCapObservations } from '@open-foresight/db';
import { yahooSymbol } from '@open-foresight/core';
import { z } from 'zod';
import type { DataProvider } from '../../index.js';

export type YahooInput = { symbols: string[] };
export type YahooReport = {
  source: 'yahoo_python'; requested: number; observed: number;
  /** Yahoo returned an error or no usable shares or market cap. */
  missing: string[]; unsupported: string[];
  /** Yahoo rate limited the client. The sync stopped there and did not retry. */
  rateLimited: boolean; notAttempted: string[]; observedAt: Date;
};
export type YahooRunner = (items: Array<{ symbol: string; yahoo: string }>) => Promise<{ lines: string[]; exitCode: number; stderr: string }>;

const symbolSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z]{1,6}$/);
const inputSchema = z.object({ symbols: z.array(symbolSchema).min(1).max(5000) });
const num = z.number().finite().positive().nullish();
const line = z.object({ symbol: z.string(), yahoo: z.string(), shares: num, marketCap: num, price: num, currency: z.string().nullish(), error: z.string().optional() });

/** Yahoo quotes London in pence (`GBp`). Caps are then in pence too. Convert to pounds. */
export function normalizeYahoo(row: { marketCap?: number | null; price?: number | null; currency?: string | null }) {
  const pence = row.currency === 'GBp' || row.currency === 'GBX';
  return { currency: pence ? 'GBP' : row.currency ?? null, marketCap: row.marketCap == null ? null : pence ? row.marketCap / 100 : row.marketCap, price: row.price == null ? null : pence ? row.price / 100 : row.price };
}

const projectDir = fileURLToPath(new URL('../../../../../tools/yahoo/', import.meta.url));

/** Runs `tools/yahoo/fetch.py`, or the script named in `options.script`, through uv. It sends the symbol list on stdin and reads one JSON line per symbol. */
export function uvRunner(options: { projectDir?: string; timeoutMs?: number; script?: string } = {}): YahooRunner {
  const dir = options.projectDir ?? projectDir;
  return items => new Promise((resolve, reject) => {
    const child = spawn('uv', ['run', '--quiet', '--project', dir, 'python', `${dir}${options.script ?? 'fetch.py'}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Yahoo reader timed out')); }, options.timeoutMs ?? 3_600_000);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-600); });
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Could not start uv: ${error.message}`)); });
    child.on('close', code => { clearTimeout(timer); resolve({ lines: out.split('\n').filter(Boolean), exitCode: code ?? 1, stderr: err }); });
    child.stdin.end(JSON.stringify(items));
  });
}

/**
 * Reads current shares outstanding and market cap through the Python yfinance package, run with uv.
 * Yahoo's terms bar automated collection, so this is for personal, educational use. It adds no proxies and never retries a rate limit.
 * Observations are snapshots of the fetch day. They suit runs for today, not backtests.
 */
export function createYahooProvider(options: { db: PostgresJsDatabase; run?: YahooRunner; now?: () => Date }): DataProvider<YahooInput, YahooReport> {
  const run = options.run ?? uvRunner();
  return {
    id: 'yahoo_python', capabilities: ['prices'] as const,
    async sync(input) {
      const parsed = inputSchema.parse(input);
      const items: Array<{ symbol: string; yahoo: string }> = [];
      const unsupported: string[] = [];
      for (const symbol of new Set(parsed.symbols)) {
        const yahoo = yahooSymbol(symbol);
        if (yahoo) items.push({ symbol, yahoo }); else unsupported.push(symbol);
      }
      const result = items.length ? await run(items) : { lines: [], exitCode: 0, stderr: '' };
      if (result.exitCode !== 0 && result.exitCode !== 3) throw new Error(`Yahoo reader failed with exit code ${result.exitCode}: ${result.stderr.slice(-200)}`);
      const rows: Array<typeof marketCapObservations.$inferInsert> = [];
      const seen = new Set<string>();
      const missing: string[] = [];
      let rateLimited = result.exitCode === 3;
      const observedAt = (options.now ?? (() => new Date()))();
      for (const text of result.lines) {
        const parsedLine = line.parse(JSON.parse(text));
        if (parsedLine.error === 'rate_limited') { rateLimited = true; continue; }
        seen.add(parsedLine.symbol);
        const { currency, marketCap, price } = normalizeYahoo(parsedLine);
        if (parsedLine.error || (parsedLine.shares == null && marketCap == null)) { missing.push(parsedLine.symbol); continue; }
        rows.push({ source: 'yahoo_python', symbol: parsedLine.symbol, sourceSymbol: parsedLine.yahoo, sharesOutstanding: parsedLine.shares == null ? null : String(parsedLine.shares), marketCap: marketCap == null ? null : String(marketCap), price: price == null ? null : String(price), currency, observedAt });
      }
      if (rows.length) await options.db.insert(marketCapObservations).values(rows);
      return { source: 'yahoo_python', requested: parsed.symbols.length, observed: rows.length, missing, unsupported, rateLimited, notAttempted: rateLimited ? items.map(i => i.symbol).filter(s => !seen.has(s)) : [], observedAt };
    },
  };
}
