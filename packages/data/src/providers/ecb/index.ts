import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { fxRates } from '@open-foresight/db';
import { z } from 'zod';
import type { DataProvider } from '../../index.js';

export type EcbSyncInput = { currencies: string[]; from: string; to: string };
export type EcbSyncReport = { source: 'ecb'; fetched: number; inserted: number; currencies: string[]; ingestedAt: Date };

const currencySchema = z.string().regex(/^[A-Z]{3}$/).refine(c => c !== 'EUR', 'EUR is the base currency');
const dateSchema = z.string().date();
const inputSchema = z.object({ currencies: z.array(currencySchema).min(1).max(40), from: dateSchema, to: dateSchema });
const rowSchema = z.object({ CURRENCY: currencySchema, CURRENCY_DENOM: z.literal('EUR'), EXR_TYPE: z.literal('SP00'), TIME_PERIOD: dateSchema, OBS_VALUE: z.string() });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Parses ECB `csvdata` with `detail=dataonly`. Rows with an empty value are skipped. */
export function parseEcbCsv(text: string): Array<{ currency: string; date: string; perEur: string }> {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  if (!header) throw new Error('ECB response is empty');
  const columns = header.split(',');
  return lines.flatMap(line => {
    const cells = line.split(',');
    if (cells.length !== columns.length) throw new Error('ECB CSV row has the wrong number of columns');
    const row = rowSchema.parse(Object.fromEntries(columns.map((name, i) => [name, cells[i]])));
    if (row.OBS_VALUE === '') return [];
    const value = Number(row.OBS_VALUE);
    if (!Number.isFinite(value) || value <= 0) throw new Error('ECB rate is not a positive number');
    return [{ currency: row.CURRENCY, date: row.TIME_PERIOD, perEur: row.OBS_VALUE }];
  });
}

/** Free and keyless. Rates are euro reference rates, units of currency per euro. */
export function createEcbFxProvider(options: { db: PostgresJsDatabase; fetch?: typeof fetch; baseUrl?: string; now?: () => Date }): DataProvider<EcbSyncInput, EcbSyncReport> {
  const fetcher = options.fetch ?? fetch;
  const base = (options.baseUrl ?? 'https://data-api.ecb.europa.eu').replace(/\/$/, '');
  return {
    id: 'ecb', capabilities: ['prices'] as const,
    async sync(input) {
      const parsed = inputSchema.parse(input);
      if (parsed.from > parsed.to) throw new Error('ECB from date is after to date');
      const currencies = [...new Set(parsed.currencies)].sort();
      const url = `${base}/service/data/EXR/D.${currencies.join('+')}.EUR.SP00.A?${new URLSearchParams({ startPeriod: parsed.from, endPeriod: parsed.to, format: 'csvdata', detail: 'dataonly' })}`;
      let text: string | undefined;
      for (let attempt = 0; attempt < 3 && text === undefined; attempt++) {
        let response: Response;
        try { response = await fetcher(url, { signal: AbortSignal.timeout(30_000) }); }
        catch (error) {
          if (attempt === 2 || (error instanceof Error && error.name === 'AbortError')) throw new Error('ECB request failed');
          await sleep(1000 * (attempt + 1)); continue;
        }
        if (response.status === 404) { text = ''; break; }
        if (response.ok) { text = await response.text(); break; }
        if ((response.status !== 429 && response.status < 500) || attempt === 2) throw new Error(`ECB returned HTTP ${response.status}`);
        await sleep(1000 * (attempt + 1));
      }
      const rows = text ? parseEcbCsv(text) : [];
      const ingestedAt = (options.now ?? (() => new Date()))();
      const inserted = await options.db.transaction(async tx => {
        let count = 0;
        for (let i = 0; i < rows.length; i += 1000) count += (await tx.insert(fxRates).values(rows.slice(i, i + 1000).map(r => ({ source: 'ecb', currency: r.currency, date: r.date, perEur: r.perEur, ingestedAt }))).onConflictDoNothing().returning({ id: fxRates.id })).length;
        return count;
      });
      return { source: 'ecb', fetched: rows.length, inserted, currencies, ingestedAt };
    },
  };
}
