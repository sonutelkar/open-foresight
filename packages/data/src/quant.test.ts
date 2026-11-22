import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, marketCapObservations, priceBars, secFacts, secSourceDocuments } from '@open-foresight/db';
import type { QuantId } from '@open-foresight/core';
import { computeQuant } from './quant.js';

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('quant functions on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  const tag = Math.random().toString(36).slice(2, 8);
  const stamp = new Date('2026-01-01T00:00:00Z');
  let n = 0;
  async function source() {
    const [s] = await db.insert(secSourceDocuments).values({ url: `q/${tag}/${n}`, transportUrl: `q/${tag}/${n}`, sha256: `${tag}${n++}`, body: '', fetchedAt: stamp }).returning({ id: secSourceDocuments.id });
    return s!.id;
  }
  const fact = (cik: string, sourceId: string, concept: string, value: number, start: string | null, end: string, filedAt: string, over: { unit?: string; accession?: string } = {}) => ({
    key: `${tag}/${cik}/${concept}/${start}/${end}/${filedAt}/${over.unit ?? 'USD'}`, cik, accession: over.accession ?? `0000000000-${filedAt.slice(2, 4)}-000001`, taxonomy: 'us-gaap', concept, unit: over.unit ?? 'USD',
    value: String(value), periodStart: start, periodEnd: end, filedAt, form: '10-K', raw: {}, sourceId, sourcePointer: `/facts/us-gaap/${concept}`, ingestedAt: stamp,
  });
  const run = (snapshotId: string, quantId: QuantId, ciks: string[], asOf: string, symbol = 'T.US') => computeQuant({ db, snapshotId, asOf, quantId, symbol, ciks });

  it('computes financial ratios from the annual fiscal period, in code, with traceable inputs', async () => {
    const cik = `95${Math.floor(Math.random() * 1e8)}`.padStart(10, '0');
    const s = await source();
    await db.insert(secFacts).values([
      fact(cik, s, 'Revenues', 800, '2024-10-01', '2025-09-30', '2025-10-31'),
      fact(cik, s, 'RevenueFromContractWithCustomerExcludingAssessedTax', 999, '2024-10-01', '2025-09-30', '2025-10-31'),
      fact(cik, s, 'ResearchAndDevelopmentExpense', 96, '2024-10-01', '2025-09-30', '2025-10-31'),
      fact(cik, s, 'PaymentsToAcquirePropertyPlantAndEquipment', 40, '2024-10-01', '2025-09-30', '2025-10-31'),
      fact(cik, s, 'GrossProfit', 360, '2024-10-01', '2025-09-30', '2025-10-31'),
      fact(cik, s, 'Revenues', 1000, '2025-10-01', '2026-09-30', '2026-11-03'),
      fact(cik, s, 'GrossProfit', 450, '2025-10-01', '2026-09-30', '2026-11-03'),
      fact(cik, s, 'Revenues', 250, '2026-07-01', '2026-09-30', '2026-11-03'),
      fact(cik, s, 'ResearchAndDevelopmentExpense', 999999, '2026-07-01', '2026-09-30', '2026-11-03'),
      fact(cik, s, 'ResearchAndDevelopmentExpense', 5, '2025-10-01', '2026-09-30', '2026-11-03', { unit: 'EUR' }),
    ]);
    const snapshot = await createSnapshot({ db });
    const before = '2026-11-02', after = '2026-11-03';

    const rdBefore = await run(snapshot.id, 'rd_intensity', [cik], before);
    expect(rdBefore.value).toBeCloseTo(96 / 800, 12);
    expect(rdBefore.inputs).toHaveLength(2);
    expect(rdBefore.inputs[0]).toMatchObject({ kind: 'fact', concept: 'ResearchAndDevelopmentExpense', value: 96, periodEnd: '2025-09-30', filedAt: '2025-10-31', sourcePointer: '/facts/us-gaap/ResearchAndDevelopmentExpense' });
    expect(rdBefore.inputs[1]).toMatchObject({ concept: 'Revenues', value: 800 });

    // FY2026 revenue exists, but its R&D is a quarter or a foreign currency, so the latest complete pair is still FY2025.
    expect((await run(snapshot.id, 'rd_intensity', [cik], after)).value).toBeCloseTo(96 / 800, 12);
    expect((await run(snapshot.id, 'capex_intensity', [cik], before)).value).toBeCloseTo(40 / 800, 12);
    expect((await run(snapshot.id, 'gross_margin', [cik], before)).value).toBeCloseTo(0.45, 12);
    // After the FY2026 filing the newest annual pair is used.
    expect((await run(snapshot.id, 'gross_margin', [cik], after)).value).toBeCloseTo(0.45, 12);
    const growthBefore = await run(snapshot.id, 'revenue_growth_yoy', [cik], before);
    expect(growthBefore.value).toBeNull();
    expect(growthBefore.note).toContain('prior year');
    expect((await run(snapshot.id, 'revenue_growth_yoy', [cik], after)).value).toBeCloseTo(0.25, 12);
    expect((await run(snapshot.id, 'capex_intensity', [cik], after)).value).toBeCloseTo(40 / 800, 12);
  });

  it('returns null with a note when there is no data, no pair or no positive revenue', async () => {
    const cik = `96${Math.floor(Math.random() * 1e8)}`.padStart(10, '0');
    const s = await source();
    await db.insert(secFacts).values([fact(cik, s, 'Revenues', 0, '2024-10-01', '2025-09-30', '2025-10-31'), fact(cik, s, 'ResearchAndDevelopmentExpense', 10, '2024-10-01', '2025-09-30', '2025-10-31')]);
    const snapshot = await createSnapshot({ db });
    expect((await run(snapshot.id, 'rd_intensity', [cik], '2026-01-01')).note).toContain('not positive');
    expect((await run(snapshot.id, 'gross_margin', [cik], '2026-01-01')).note).toContain('GrossProfit');
    const none = await run(snapshot.id, 'rd_intensity', ['0000000001'], '2026-01-01');
    expect(none).toMatchObject({ value: null, inputs: [] });
    expect(none.note).toContain('US filers');
    await expect(run(snapshot.id, 'made_up' as QuantId, [cik], '2026-01-01')).rejects.toThrow('Unknown quant function');
  });

  it('computes market values and a split adjusted return from stored bars and observations', async () => {
    const symbol = `Q${tag.toUpperCase()}.US`, retSymbol = `R${tag.toUpperCase()}.US`;
    const bars = Array.from({ length: 12 }, (_, i) => ({ source: 'eodhd', symbol, date: `2026-10-${String(10 + i).padStart(2, '0')}`, close: '100', volume: '1000000', contentHash: `q${i}`, raw: {}, ingestedAt: stamp }));
    await db.insert(priceBars).values([
      ...bars,
      { source: 'eodhd', symbol: retSymbol, date: '2025-10-30', close: '100', adjustedClose: '50', volume: '1', contentHash: 'r0', raw: {}, ingestedAt: stamp },
      { source: 'eodhd', symbol: retSymbol, date: '2026-10-30', close: '60', adjustedClose: '60', volume: '1', contentHash: 'r1', raw: {}, ingestedAt: stamp },
    ]);
    await db.insert(marketCapObservations).values({ source: 'yahoo_python', symbol, sourceSymbol: symbol, marketCap: '5000000000', observedAt: new Date('2026-10-31T12:00:00Z') });
    const snapshot = await createSnapshot({ db });
    const cap = await run(snapshot.id, 'market_cap_usd', [], '2026-10-31', symbol);
    expect(cap.value).toBe(5e9);
    expect(cap.inputs).toContainEqual({ kind: 'derived', name: 'market_cap_source', value: 'observed' });
    expect((await run(snapshot.id, 'adv_usd_20d', [], '2026-10-31', symbol)).value).toBe(1e8);
    expect((await run(snapshot.id, 'price_return_12m', [], '2026-10-30', retSymbol)).value).toBeCloseTo(0.2, 12);
    const stale = await run(snapshot.id, 'price_return_12m', [], '2026-12-30', retSymbol);
    expect(stale).toMatchObject({ value: null, note: 'No recent price' });
    const noStart = await run(snapshot.id, 'price_return_12m', [], '2026-10-31', symbol);
    expect(noStart.value).toBeNull();
    expect((await run(snapshot.id, 'adv_usd_20d', [], '2026-10-31', 'NOBARS.US')).value).toBeNull();
    expect((await run(snapshot.id, 'market_cap_usd', [], '2026-10-31', 'ABC.TO')).note).toContain('Unsupported exchange');
  });
});
