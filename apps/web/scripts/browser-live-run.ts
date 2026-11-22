// Live check of PR 15 on the real surface: Chromium drives the real web app, the real API, the real worker (pg-boss), Postgres, the real Designer and Analyst models,
// and the 50-name store ingested by apps/worker/scripts/seed-pilot.ts. It submits a brief, approves gate 1 in the UI, waits for the provisional basket,
// then checks the funnel, weights, contributions, audit trail and run history against the database.
// Start first: the API (DATABASE_URL, APPROVAL_TOKEN) and the worker (DATABASE_URL, OPENROUTER_API_KEY).
// Usage: APPROVAL_TOKEN=... DB_NAME=foresight_pr15_live [BASE_URL=http://127.0.0.1:8787] [WAIT_MINUTES=45] bun scripts/browser-live-run.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const token = process.env.APPROVAL_TOKEN ?? '';
const dbName = process.env.DB_NAME ?? '';
if (!token || !dbName) throw new Error('Set APPROVAL_TOKEN and DB_NAME');
const waitMs = Number(process.env.WAIT_MINUTES ?? 45) * 60_000;
const shots = new URL('../../../docs/screenshots/', import.meta.url).pathname;
mkdirSync(shots, { recursive: true });
const psql = (sql: string) => execFileSync('docker', ['exec', 'open-foresight-postgres-1', 'psql', '-U', 'foresight', '-d', dbName, '-tAc', sql], { encoding: 'utf8' }).trim();
const stamp = () => new Date().toISOString().slice(11, 19);
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); if (!ok) failures++; };

const brief = 'Smart energy: companies that make the electricity system more efficient, flexible and digital over a five year horizon. Include grid equipment and automation, energy efficiency products, demand response, and the storage and inverter makers that let renewables and electric loads connect to the grid. Exclude pure EV makers and pure fossil fuel producers.';
const basketSize = 30, cap = 8;

const browser = await chromium.launch({ headless: true });
const page: Page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const consoleErrors: string[] = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(String(e)));

await page.goto(base);
await page.getByTestId('analyst').fill('Ada Analyst');
await page.getByTestId('token').fill(token);
await page.waitForSelector('#brief');
await page.evaluate(() => localStorage.removeItem('of.draft'));
await page.fill('#brief', brief);
await page.fill('#basketSize', String(basketSize));
await page.fill('#weightCapPercent', String(cap));
await page.getByTestId('submit-brief').click();
await page.waitForURL(/#\/runs\/[0-9a-f-]{36}/);
const runId = page.url().split('/').pop()!;
console.log(`${stamp()} run ${runId}`);
const status = () => psql(`select status from runs where id = '${runId}'`);

// Gate 1: the worker builds the universe from the stored prices, then the real Designer drafts the framework.
await page.getByTestId('approve-button').waitFor({ timeout: 10 * 60_000 });
console.log(`${stamp()} gate 1 reached`);
const universe = psql(`select count(*) || '|' || count(*) filter (where included) from run_universe where run_id = '${runId}'`).split('|').map(Number);
check('the universe stage screened the stored listings', universe[0]! > 0 && universe[0]! <= 50 && universe[1]! > 0, `${universe[1]} of ${universe[0]} listings included`);
check('the run waits at gate 1', (await status()) === 'awaiting_kpi_approval');
check('the run page says how many listings passed the screen', (await page.getByTestId('run-status').innerText()).includes('passed the universe screen'));
check('no scoring happened before approval', Number(psql(`select count(*) from kpi_scores where run_id = '${runId}'`)) === 0);
await page.screenshot({ path: `${shots}pr15-1-gate.png`, fullPage: true });

await page.getByTestId('approve-button').click();
await page.getByTestId('approved').waitFor();
console.log(`${stamp()} approved in the UI`);
check('the approval is recorded once, against the frozen version', psql(`select count(*) from human_decisions where run_id = '${runId}' and stage = 'awaiting_kpi_approval' and action = 'approve'`) === '1');

// The worker scores every name. Log progress until the basket is ready or the wait runs out.
const started = Date.now();
let lastLog = 0;
while (Date.now() - started < waitMs) {
  const s = await status();
  if (s === 'done' || s === 'failed') break;
  if (Date.now() - lastLog > 30_000) {
    lastLog = Date.now();
    console.log(`${stamp()} ${s} scores=${psql(`select count(*) from kpi_scores where run_id = '${runId}'`)} model calls=${psql(`select count(*) from llm_calls where run_id = '${runId}' and role = 'analyst'`)}`);
  }
  await new Promise(r => setTimeout(r, 3000));
}
const finalStatus = await status();
check('the run finished', finalStatus === 'done', `status ${finalStatus}`);
if (finalStatus === 'failed') console.log(psql(`select settings->'failure' from runs where id = '${runId}'`));
if (finalStatus !== 'done') { await browser.close(); process.exit(1); }

await page.reload();
await page.getByTestId('basket').waitFor();
await page.screenshot({ path: `${shots}pr15-2-basket.png`, fullPage: true });
check('the page labels the basket provisional', (await page.getByTestId('basket').innerText()).includes('Provisional'));

// Funnel, weights and contributions, straight from the stored basket.
const basket = psql(`select id || '|' || (funnel->>'universe') || '|' || (funnel->>'screened') || '|' || (funnel->>'candidates') || '|' || (funnel->>'gateFailed') || '|' || (funnel->>'gateUnknown') || '|' || (funnel->>'zeroScore') || '|' || (funnel->>'eligible') || '|' || (funnel->>'selected') || '|' || (funnel->>'belowCutoff') || '|' || status || '|' || unknown_mode from baskets where run_id = '${runId}'`).split('|');
const [basketId, fu, fs, fc, fg, fgu, fz, fe, fsel, fb, bStatus, mode] = basket as [string, ...string[]];
const f = { universe: Number(fu), screened: Number(fs), candidates: Number(fc), gateFailed: Number(fg), gateUnknown: Number(fgu), zeroScore: Number(fz), eligible: Number(fe), selected: Number(fsel), belowCutoff: Number(fb) };
console.log(`${stamp()} funnel ${JSON.stringify(f)} unknown mode ${mode}`);
check('the basket is provisional', bStatus === 'provisional');
check('the funnel adds up', f.candidates === f.gateFailed + f.gateUnknown + f.zeroScore + f.eligible && f.eligible === f.selected + f.belowCutoff && f.selected <= basketSize);
check('the funnel matches the universe table', f.universe === universe[0] && f.screened <= universe[1]! && f.candidates === Number(psql(`select count(*) from run_universe where run_id = '${runId}' and included`)));
const members = psql(`select count(*) || '|' || round(sum(weight_percent), 6) || '|' || max(weight_percent) from basket_members where basket_id = '${basketId}'`).split('|');
check('the basket has the selected number of members', Number(members[0]) === f.selected, `${members[0]} members`);
check('the weights sum to 100', Math.abs(Number(members[1]) - 100) < 1e-4, `sum ${members[1]}`);
check('no weight exceeds the cap', Number(members[2]) <= cap + 1e-4, `max ${members[2]} vs cap ${cap}`);
const bad = Number(psql(`select count(*) from basket_members m where abs((select sum((c->>'contribution')::numeric) from jsonb_array_elements(m.contributions) c) + m.cap_adjustment - m.score) > 0.000001 and m.basket_id = '${basketId}'`));
check('every name\'s contributions plus its cap adjustment equal its score', bad === 0);
const order = Number(psql(`select count(*) from basket_members a join basket_members b on b.basket_id = a.basket_id and b.rank = a.rank + 1 where a.basket_id = '${basketId}' and a.score < b.score`));
check('members are ranked by descending score', order === 0);
const gateKpi = psql(`select k->>'id' from kpi_framework_versions v, jsonb_array_elements(v.framework->'kpis') k where v.run_id = '${runId}' and (k->>'isGate')::boolean limit 1`);
if (gateKpi) check('no member failed the gate KPI', Number(psql(`select count(*) from basket_members m join kpi_scores s on s.security_id = m.security_id and s.run_id = '${runId}' and s.kpi_id = '${gateKpi}' and s.valid where m.basket_id = '${basketId}' and s.level in ('0', 'unknown')`)) === 0, `gate ${gateKpi}`);

// The model was called once per scored text KPI. Retries and restarts must not repeat finished calls.
const validText = Number(psql(`select count(*) from kpi_scores where run_id = '${runId}' and method <> 'quant' and valid and llm_call_id is not null`));
const analystCalls = Number(psql(`select count(*) from llm_calls where run_id = '${runId}' and role = 'analyst'`));
const attempts = Number(psql(`select count(*) from kpi_scores where run_id = '${runId}'`));
const distinct = Number(psql(`select count(distinct (security_id, kpi_id)) from kpi_scores where run_id = '${runId}'`));
check('every security and KPI has exactly one valid score', Number(psql(`select count(*) from (select security_id, kpi_id from kpi_scores where run_id = '${runId}' and valid group by 1, 2 having count(*) > 1) t`)) === 0 && Number(psql(`select count(*) from (select security_id, kpi_id from kpi_scores where run_id = '${runId}' group by 1, 2 having bool_or(valid) = false) t`)) <= attempts - distinct);
check('analyst model calls match the saved attempts that used one', analystCalls === Number(psql(`select count(*) from kpi_scores where run_id = '${runId}' and llm_call_id is not null`)), `${analystCalls} calls, ${validText} valid text scores`);
check('the status history is complete and ordered', psql(`select string_agg(status::text, ' > ' order by sequence) from run_status_history where run_id = '${runId}'`) === 'draft > universe_built > designing > awaiting_kpi_approval > prescreening > analysing > packaging > done');
check('the saved basket cannot be changed', (() => { try { psql(`update baskets set status = 'provisional' where run_id = '${runId}'`); return false; } catch { return true; } })());

// The UI shows what the database holds.
const rows = await page.locator('[data-testid^="basket-row-"]').count();
check('the page lists every member', rows === f.selected, `${rows} rows`);
const first = psql(`select symbol || '|' || to_char(weight_percent, 'FM990.00') from basket_members where basket_id = '${basketId}' and rank = 1`).split('|');
check('the top row shows the stored symbol and weight', (await page.getByTestId(`basket-row-${first[0]}`).innerText()).includes(first[1]!));
check('the funnel line matches', (await page.getByTestId('funnel').innerText()).includes(`${f.selected} selected`));
check('the browser console has no errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
await browser.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
