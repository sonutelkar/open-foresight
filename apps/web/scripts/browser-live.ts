// Live check of PR 14 in a real browser: Chromium drives the real web app, the real API, Postgres and the real Designer model.
// Start the API first: DATABASE_URL=... OPENROUTER_API_KEY=... APPROVAL_TOKEN=... bun apps/api/src/server.ts
// Usage: APPROVAL_TOKEN=... DB_NAME=foresight_pr14_live [BASE_URL=http://127.0.0.1:8787] bun scripts/browser-live.ts
// It saves screenshots to docs/screenshots and exits non-zero if any check fails.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const token = process.env.APPROVAL_TOKEN ?? '';
const dbName = process.env.DB_NAME ?? '';
if (!token || !dbName) throw new Error('Set APPROVAL_TOKEN and DB_NAME');
const shots = new URL('../../../docs/screenshots/', import.meta.url).pathname;
mkdirSync(shots, { recursive: true });
const psql = (sql: string) => execFileSync('docker', ['exec', 'open-foresight-postgres-1', 'psql', '-U', 'foresight', '-d', dbName, '-tAc', sql], { encoding: 'utf8' }).trim();

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); if (!ok) failures++; };
const runCount = async () => ((await (await fetch(`${base}/api/runs`)).json()) as unknown[]).length;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page: Page = await context.newPage();
const consoleErrors: string[] = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(String(e)));

await page.goto(base);
await page.getByTestId('analyst').fill('Ada Analyst');
await page.getByTestId('token').fill(token);
await page.waitForSelector('#brief');
check('the brief form loads with today as the as-of date', (await page.inputValue('#asOf')) === new Date().toISOString().slice(0, 10));
await page.screenshot({ path: `${shots}pr14-1-brief-form.png`, fullPage: true });

// 1. Invalid submissions stay blocked and create nothing.
const before = await runCount();
const submit = page.getByTestId('submit-brief');
check('submit starts disabled for an empty brief', await submit.isDisabled());
await page.fill('#brief', 'Too short for a real theme.');
await page.locator('#brief').blur();
check('a short brief shows the word count error', (await page.locator('[data-field="brief"]').first().innerText()).includes('at least 20 words'));
const typed = 'Too short for a real theme.';
check('the word counter shows the count', (await page.getByTestId('word-count').innerText()).startsWith(`${typed.split(/\s+/).length} of at least 20`));
check('submit is disabled for a short brief', await submit.isDisabled());
const longBrief = 'Smart energy: companies that make the electricity system more efficient, flexible and digital over a five year horizon. Include grid equipment and automation, energy efficiency products, demand response, and the storage and inverter makers that let grids absorb variable renewables, including second order suppliers. Exclude pure electric vehicle makers and pure fossil fuel producers.';
await page.fill('#brief', longBrief);
await page.fill('#asOf', '2099-01-01');
await page.locator('#asOf').blur();
check('a future as-of date shows an error', (await page.locator('[data-field="asOf"]').first().innerText()).includes('after today'));
check('submit is disabled for a future date', await submit.isDisabled());
await page.fill('#asOf', new Date().toISOString().slice(0, 10));
await page.fill('#basketSize', '10');
await page.fill('#weightCapPercent', '5');
await page.locator('#weightCapPercent').blur();
check('an infeasible cap shows one error with the capacity', (await page.locator('[data-field="weightCapPercent"]').first().innerText()).includes('at most 50 percent') && (await page.getByTestId('capacity').count()) === 0);
check('submit is disabled for an infeasible cap', await submit.isDisabled());
await page.screenshot({ path: `${shots}pr14-2-invalid-brief.png`, fullPage: true });
await page.getByTestId('submit-brief').click({ force: true }).catch(() => undefined);
check('forcing a click on a blocked submit creates no run', (await runCount()) === before);
await page.getByTestId('token').fill('wrong-token');
await page.fill('#basketSize', '40');
check('with a bad token the server rejects a valid brief', await (async () => {
  const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-approval-token': 'wrong-token', 'x-analyst': 'Ada Analyst' }, body: JSON.stringify({ brief: longBrief }) });
  return res.status === 401;
})());
await page.getByTestId('token').fill(token);

// 2. A valid brief starts a real run.
check('submit enables for a valid brief', await submit.isEnabled());
await submit.click();
await page.waitForURL(/#\/runs\/[0-9a-f-]{36}$/);
const runId = page.url().split('/').at(-1) ?? '';
check('a new run was created', (await runCount()) === before + 1);
await page.getByTestId('designing').waitFor({ timeout: 15_000 });
check('the run shows the Designer is working', true);
await page.screenshot({ path: `${shots}pr14-3-designing.png` });
const started = Date.now();
await page.locator('[data-testid^="kpi-row-"]').first().waitFor({ timeout: 240_000 });
console.log(`INFO  the real Designer finished in ${((Date.now() - started) / 1000).toFixed(0)}s`);
check('the run reaches KPI approval', (await page.getByTestId('run-status').innerText()).includes('awaiting kpi approval'));
const rows = page.locator('[data-testid^="kpi-row-"]');
const kpiCount = await rows.count();
check('the gate shows 3 to 8 KPIs', kpiCount >= 3 && kpiCount <= 8, `${kpiCount} KPIs`);
check('the weights start at 100 percent', (await page.getByTestId('weight-total').innerText()) === '100%');
check('approve is enabled for the drafted framework', await page.getByTestId('approve-button').isEnabled());
await page.screenshot({ path: `${shots}pr14-4-gate.png`, fullPage: true });

// 3. Edit a rubric, then break the framework in each way and confirm approval stays blocked.
let editedKpi = -1;
for (let i = 0; i < kpiCount; i++) {
  await rows.nth(i).locator('button.link').click();
  if (await page.getByTestId('rubric-level-3').count()) { editedKpi = i; break; }
}
check('a KPI with a rubric can be opened', editedKpi >= 0);
const marker = ' Reviewed and tightened by the analyst: the figure must be disclosed, not estimated.';
const level3 = page.getByTestId('rubric-level-3');
const original3 = await level3.inputValue();
await level3.fill(original3 + marker);
check('the rubric edit keeps approval enabled', await page.getByTestId('approve-button').isEnabled());

const rowIds = await rows.evaluateAll(els => els.map(e => e.getAttribute('data-testid')!.replace('kpi-row-', '')));
const weights = await Promise.all(rowIds.map(id => page.getByTestId(`weight-${id}`).inputValue()));
await page.getByTestId(`weight-${rowIds[0]}`).fill(String(Number(weights[0]) + 5));
check('weights over 100 block approval and name the total', (await page.getByTestId('weight-total').innerText()) === '105%' && await page.getByTestId('approve-button').isDisabled() && (await page.getByTestId('problems').innerText()).includes('got 105'));
await page.screenshot({ path: `${shots}pr14-5-weights-blocked.png`, fullPage: true });
await page.getByTestId(`weight-${rowIds[0]}`).fill(weights[0]!);
check('restoring the weights re-enables approval', await page.getByTestId('approve-button').isEnabled());

const gates = await Promise.all(rowIds.map(id => page.getByTestId(`gate-${id}`).isChecked()));
const needGates = Math.max(0, 2 - gates.filter(Boolean).length);
const toggled: string[] = [];
for (let i = 0; i < rowIds.length && toggled.length < needGates; i++) if (!gates[i]) { await page.getByTestId(`gate-${rowIds[i]}`).check(); toggled.push(rowIds[i]!); }
check('two gates block approval', await page.getByTestId('approve-button').isDisabled() && (await page.getByTestId('problems').innerText()).includes('At most one KPI'));
for (const id of toggled) await page.getByTestId(`gate-${id}`).uncheck();
check('removing the extra gate re-enables approval', await page.getByTestId('approve-button').isEnabled());

await rows.nth(editedKpi).locator('button.link').click();
await page.getByTestId('rubric-level-2').fill('');
check('an incomplete rubric blocks approval and the KPI shows the problem', await page.getByTestId('approve-button').isDisabled() && (await page.getByTestId('kpi-problems').innerText()).includes('anchored rubric'));
await page.screenshot({ path: `${shots}pr14-6-rubric-blocked.png`, fullPage: true });
await page.getByTestId('rubric-level-2').fill('A disclosed figure supports a middle level, with a named product or segment.');
check('completing the rubric re-enables approval', await page.getByTestId('approve-button').isEnabled());
await page.fill('#exclusions', 'pure EV makers\npure fossil fuel producers');

// 4. Approve and inspect the frozen version and the decision.
await page.fill('#reason', 'Tightened the level 3 rubric.');
check('the hint says the framework was edited', (await page.getByTestId('approve-hint').innerText()).includes('edited'));
await page.getByTestId('approve-button').click();
await page.getByTestId('approved').waitFor({ timeout: 15_000 });
await page.screenshot({ path: `${shots}pr14-7-approved.png`, fullPage: true });
const versionId = (await page.getByTestId('version-id').innerText()).trim();
check('the page shows who approved', (await page.getByTestId('approved-by').innerText()) === 'Ada Analyst');
check('the page shows the decision with the note', (await page.getByTestId('decision').innerText()).includes('Ada Analyst approved') && (await page.getByTestId('decision').innerText()).includes('Tightened the level 3 rubric.'));
check('the approve button is gone after approval', (await page.getByTestId('approve-button').count()) === 0);

// 5. Inspect the stored truth directly in Postgres, independent of the API and the page.
check('database: one frozen version for the run, marked edited', psql(`select count(*) || '|' || bool_and(edited)::text || '|' || max(approved_by) from kpi_framework_versions where run_id = '${runId}'`) === '1|true|Ada Analyst');
check('database: the version holds the edited rubric and the exclusions', psql(`select (framework::text like '%Reviewed and tightened by the analyst%')::text || '|' || (exclusions::text like '%pure fossil fuel producers%')::text from kpi_framework_versions where id = '${versionId}'`) === 'true|true');
check('database: the model draft is unchanged', psql(`select (draft::text like '%Reviewed and tightened%')::text from kpi_framework_drafts where run_id = '${runId}' and valid`) === 'false');
check('database: one decision, attributed, targeting the version', psql(`select user_id || '|' || stage || '|' || action || '|' || (target = '${versionId}')::text from human_decisions where run_id = '${runId}'`) === 'Ada Analyst|awaiting_kpi_approval|approve|true');
check('database: the run moved on and points at the version', psql(`select status || '|' || (framework_version = '${versionId}')::text from runs where id = '${runId}'`) === 'prescreening|true');
check('database: the status history is complete and ordered', psql(`select string_agg(status::text, ' > ' order by sequence) from run_status_history where run_id = '${runId}'`) === 'draft > universe_built > designing > awaiting_kpi_approval > prescreening');
check('database: the Designer call is audited with its prompt version', /^designer@v2:[0-9a-f]{12}\|anthropic\/claude-opus-5\.5$/.test(psql(`select prompt_version || '|' || model from llm_calls where run_id = '${runId}' and role = 'designer' limit 1`)));

// 6. A second approval and a wrong token are refused by the server.
const body = JSON.stringify({ framework: ((await (await fetch(`${base}/api/runs/${runId}`)).json()) as { versions: Array<{ framework: unknown }> }).versions[0]?.framework });
const again = await fetch(`${base}/api/runs/${runId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-approval-token': token, 'x-analyst': 'Ada Analyst' }, body });
check('a second approval is refused', again.status === 409);
check('an approval with a wrong token is refused', (await fetch(`${base}/api/runs/${runId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-approval-token': 'nope', 'x-analyst': 'Ada Analyst' }, body })).status === 401);
check('the browser logged no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
