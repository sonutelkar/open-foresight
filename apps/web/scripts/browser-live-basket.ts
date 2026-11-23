// Live check of PR 16 in a real browser: Chromium opens the finished basket of a stored run through the real API and Postgres,
// expands a member, and traces a displayed quote to the stored source passage and filing link. It never calls a model or a paid API.
// Start the API first (DATABASE_URL, APPROVAL_TOKEN). Usage: DB_NAME=foresight_pr15_live [RUN_ID=...] [BASE_URL=http://127.0.0.1:8787] bun scripts/browser-live-basket.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const dbName = process.env.DB_NAME ?? '';
if (!dbName) throw new Error('Set DB_NAME');
const shots = new URL('../../../docs/screenshots/', import.meta.url).pathname;
mkdirSync(shots, { recursive: true });
const psql = (sql: string) => execFileSync('docker', ['exec', 'open-foresight-postgres-1', 'psql', '-U', 'foresight', '-d', dbName, '-tAc', sql], { encoding: 'utf8' }).trim();
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); if (!ok) failures++; };

const runId = process.env.RUN_ID ?? psql(`select run_id from baskets order by created_at desc limit 1`);
const members = Number(psql(`select count(*) from basket_members m join baskets b on b.id = m.basket_id where b.run_id = '${runId}'`));
// A member whose latest valid score cites a passage, so there is a quote to trace.
const target = psql(`select m.symbol from basket_members m join baskets b on b.id = m.basket_id where b.run_id = '${runId}' and exists (select 1 from kpi_scores s where s.run_id = b.run_id and s.security_id = m.security_id and s.valid and jsonb_array_length(s.citations) > 0) order by m.rank limit 1`);
console.log(`run ${runId}, ${members} members, tracing ${target}`);

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
const errors: string[] = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await page.goto(`${base}/#/runs/${runId}`);
await page.getByTestId('basket').waitFor();
check('the basket is labelled provisional with the review limitation', (await page.getByTestId('basket').innerText()).includes('Provisional') && (await page.getByTestId('review-limitation').innerText()).includes('no analyst has checked'));
check('the table lists every stored member', (await page.locator('[data-testid^="basket-row-"]').count()) === members, `${members} rows`);
const first = psql(`select m.symbol || '|' || round(m.score, 3) || '|' || round(m.weight_percent, 2) from basket_members m join baskets b on b.id = m.basket_id where b.run_id = '${runId}' and m.rank = 1`).split('|');
const row = await page.locator(`[data-testid="basket-row-${first[0]}"]`).innerText();
check('the top row shows the stored score and weight', row.includes(Number(first[1]).toFixed(3)) && row.includes(Number(first[2]).toFixed(2)), row.replace(/\s+/g, ' '));
await page.screenshot({ path: `${shots}pr16-1-basket.png`, fullPage: true });

await page.getByTestId(`evidence-toggle-${target}`).click();
const panel = page.getByTestId(`evidence-${target}`);
await panel.getByTestId('quote').first().waitFor();
const quote = panel.getByTestId('quote').first();
const shown = (await quote.locator('p').innerText()).replace(/^“|”$/g, '');
const href = await quote.getByTestId('source-link').getAttribute('href');
check('every cited quote in the panel is verified against its stored passage', (await panel.locator('[data-testid="quote"][data-verified="false"]').count()) === 0);
await page.screenshot({ path: `${shots}pr16-2-evidence.png`, fullPage: true });

// Trace the displayed quote: the stored score row cites a chunk, the chunk text holds the quote, and its filing has the displayed link.
const sq = (v: string) => v.replaceAll("'", "''");
const traced = psql(`select count(*) from kpi_scores s, jsonb_array_elements(s.citations) c, document_chunks d where s.run_id = '${runId}' and s.symbol = '${sq(target ?? '')}' and s.valid and d.id = (c->>'chunkId')::uuid and lower(regexp_replace(d.text, '\\s+', ' ', 'g')) like '%' || lower(regexp_replace('${sq(shown)}', '\\s+', ' ', 'g')) || '%'`);
check('the displayed quote appears in the stored passage it cites', Number(traced) >= 1, `${traced} citing rows`);
const stored = psql(`select coalesce((select f.url from (select d.url, c->>'docId' id from kpi_scores s, jsonb_array_elements(s.citations) c, sec_filings sf, sec_source_documents d where s.run_id = '${runId}' and s.symbol = '${sq(target ?? '')}' and sf.id = (c->>'docId')::uuid and d.id = sf.document_source_id) f where '${sq(href ?? '')}' = f.url limit 1), '')`);
const esef = psql(`select count(*) from kpi_scores s, jsonb_array_elements(s.citations) c, esef_filings e where s.run_id = '${runId}' and s.symbol = '${sq(target ?? '')}' and e.id = (c->>'docId')::uuid and 'https://filings.xbrl.org' || e.report_url = '${sq(href ?? '')}'`);
check('the displayed source link is the stored filing URL', stored === href || Number(esef) >= 1, href ?? 'no link');
check('the link opens in a new tab safely', (await quote.getByTestId('source-link').getAttribute('rel'))?.includes('noopener') === true);
check('every KPI of the frozen framework has a block', (await panel.locator('[data-testid^="kpi-evidence-"]').count()) === Number(psql(`select jsonb_array_length(framework->'kpis') from kpi_framework_versions where run_id = '${runId}' order by version desc limit 1`)));
check('no console errors', errors.length === 0, errors.join(' | '));
await browser.close();
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('All checks passed');
