import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { validateBrief, type BriefError } from '@open-foresight/core';
import { ApiError, createRun, listRuns, type Auth, type Config, type RunSummary } from './api';

type Form = {
  brief: string; keywords: string; seedNames: string; exclusions: string; regions: string[];
  minMarketCapBn: string; minAdvM: string; asOf: string; exposureStyle: string; basketSize: string; weightCapPercent: string;
  weighting: string; reviewLevel: string; modelProfile: string;
};

const lines = (text: string) => text.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
const num = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const labels: Record<string, string> = { score: 'Score weighted', equal: 'Equal weight', score_sqrt_cap: 'Score times square root of market cap', kpis_and_flags: 'Approve KPIs and review flags', every_stage: 'Approve every stage', strict: 'Pure play (strict)', broad: 'Broad, including second order' };

function Field({ id, label, hint, errors, children }: { id: string; label: string; hint?: ReactNode; errors: BriefError[]; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? <p className="hint">{hint}</p> : null}
      {errors.map((e, i) => <p key={i} className="error" role="alert" data-field={id}>{e.message}</p>)}
    </div>
  );
}

export function BriefForm({ config, auth, onCreated }: { config: Config; auth: Auth; onCreated: (runId: string) => void }) {
  const [form, setForm] = useState<Form>({
    brief: '', keywords: '', seedNames: '', exclusions: '', regions: ['US', 'EU'], minMarketCapBn: '1', minAdvM: '5', asOf: config.today,
    exposureStyle: 'broad', basketSize: '40', weightCapPercent: '5', weighting: 'score', reviewLevel: 'kpis_and_flags', modelProfile: config.modelProfiles[0] ?? 'quality',
  });
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<RunSummary[]>([]);
  useEffect(() => { listRuns().then(setRecent).catch(() => undefined); }, []);

  const input = useMemo(() => ({
    brief: form.brief, keywords: lines(form.keywords), seedNames: lines(form.seedNames), exclusions: lines(form.exclusions), regions: form.regions,
    minMarketCapUsd: num(form.minMarketCapBn) * 1e9, minAdvUsd: num(form.minAdvM) * 1e6, asOf: form.asOf, exposureStyle: form.exposureStyle,
    basketSize: num(form.basketSize), weightCapPercent: num(form.weightCapPercent), weighting: form.weighting, reviewLevel: form.reviewLevel, modelProfile: form.modelProfile,
  }), [form]);
  const checked = useMemo(() => validateBrief(input, { today: config.today }), [input, config.today]);
  const errors: BriefError[] = checked.ok ? [] : checked.errors;
  const shown = (field: string) => (submitted || touched.has(field)) ? errors.filter(e => e.field === field || e.field.startsWith(`${field}.`)) : [];
  const set = (k: keyof Form, v: string) => setForm(f => ({ ...f, [k]: v }));
  const touch = (k: string) => setTouched(t => new Set(t).add(k));
  const toggleRegion = (r: string) => setForm(f => ({ ...f, regions: f.regions.includes(r) ? f.regions.filter(x => x !== r) : [...f.regions, r] }));
  const canSubmit = checked.ok && auth.analyst.trim() !== '' && auth.token.trim() !== '' && !busy;
  const capacity = Number.isFinite(num(form.basketSize) * num(form.weightCapPercent)) ? Math.round(num(form.basketSize) * num(form.weightCapPercent) * 100) / 100 : null;
  const count = words(form.brief);

  async function submit() {
    setSubmitted(true); setServer([]);
    if (!checked.ok) return;
    setBusy(true);
    try { onCreated((await createRun(checked.brief, auth)).runId); }
    catch (e) {
      setServer(e instanceof ApiError ? (e.body.errors?.map(x => x.message) ?? [e.message]) : ['The request failed']);
    } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>New theme run</h1>
        <p className="lede">Describe the theme. The Designer drafts a KPI framework from this brief, and you approve it before any stock is scored.</p>
      </header>
      <form onSubmit={e => { e.preventDefault(); void submit(); }} noValidate>
        <section className="card">
          <h2>Theme</h2>
          <Field errors={shown('brief')} id="brief" label="Theme brief" hint={<span className={count >= config.briefLimits.minWords ? 'ok' : ''} data-testid="word-count">{count} of at least {config.briefLimits.minWords} words</span>}>
            <textarea id="brief" rows={5} value={form.brief} onChange={e => set('brief', e.target.value)} onBlur={() => touch('brief')} placeholder="Grid-scale and behind-the-meter energy storage, 5-year horizon, include second-order suppliers, exclude pure EV makers" />
          </Field>
          <div className="grid2">
            <Field errors={shown('keywords')} id="keywords" label="Keywords" hint="Optional. One per line or comma separated."><textarea id="keywords" rows={3} value={form.keywords} onChange={e => set('keywords', e.target.value)} /></Field>
            <Field errors={shown('seedNames')} id="seedNames" label="Seed names" hint="Optional. Tickers you already believe fit."><textarea id="seedNames" rows={3} value={form.seedNames} onChange={e => set('seedNames', e.target.value)} /></Field>
          </div>
          <Field errors={shown('exclusions')} id="exclusions" label="Exclusions" hint="Optional. Tickers, sectors or keywords to drop."><textarea id="exclusions" rows={2} value={form.exclusions} onChange={e => set('exclusions', e.target.value)} /></Field>
        </section>

        <section className="card">
          <h2>Universe</h2>
          <fieldset>
            <legend>Regions</legend>
            <div className="row">{config.regions.map(r => <label key={r} className="check"><input type="checkbox" checked={form.regions.includes(r)} onChange={() => { toggleRegion(r); touch('regions'); }} />{r}</label>)}</div>
            {shown('regions').map((e, i) => <p key={i} className="error" role="alert" data-field="regions">{e.message}</p>)}
          </fieldset>
          <div className="grid3">
            <Field errors={shown('minMarketCapUsd')} id="minMarketCapUsd" label="Minimum market cap, $bn"><input id="minMarketCapUsd" inputMode="decimal" value={form.minMarketCapBn} onChange={e => set('minMarketCapBn', e.target.value)} onBlur={() => touch('minMarketCapUsd')} /></Field>
            <Field errors={shown('minAdvUsd')} id="minAdvUsd" label="Minimum daily traded value, $m"><input id="minAdvUsd" inputMode="decimal" value={form.minAdvM} onChange={e => set('minAdvM', e.target.value)} onBlur={() => touch('minAdvUsd')} /></Field>
            <Field errors={shown('asOf')} id="asOf" label="As-of date" hint={`Today or earlier. Earlier dates are for backtests.`}><input id="asOf" type="date" max={config.today} value={form.asOf} onChange={e => set('asOf', e.target.value)} onBlur={() => touch('asOf')} /></Field>
          </div>
        </section>

        <section className="card">
          <h2>Basket</h2>
          <fieldset>
            <legend>Exposure style</legend>
            <div className="row">{config.exposureStyles.map(s => <label key={s} className="check"><input type="radio" name="exposure" checked={form.exposureStyle === s} onChange={() => set('exposureStyle', s)} />{labels[s] ?? s}</label>)}</div>
          </fieldset>
          <div className="grid3">
            <Field errors={shown('basketSize')} id="basketSize" label="Basket size, names"><input id="basketSize" inputMode="numeric" value={form.basketSize} onChange={e => set('basketSize', e.target.value)} onBlur={() => touch('basketSize')} /></Field>
            <Field errors={shown('weightCapPercent')} id="weightCapPercent" label="Weight cap per name, %" hint={capacity === null || capacity < 100 ? undefined : <span className="ok" data-testid="capacity">{form.basketSize} names at {form.weightCapPercent}% hold up to {capacity}%</span>}>
              <input id="weightCapPercent" inputMode="decimal" value={form.weightCapPercent} onChange={e => set('weightCapPercent', e.target.value)} onBlur={() => touch('weightCapPercent')} />
            </Field>
            <Field errors={shown('weighting')} id="weighting" label="Weighting"><select id="weighting" value={form.weighting} onChange={e => set('weighting', e.target.value)}>{config.weightings.map(w => <option key={w} value={w}>{labels[w] ?? w}</option>)}</select></Field>
          </div>
          <div className="grid2">
            <Field errors={shown('reviewLevel')} id="reviewLevel" label="Review level"><select id="reviewLevel" value={form.reviewLevel} onChange={e => set('reviewLevel', e.target.value)}>{config.reviewLevels.map(w => <option key={w} value={w}>{labels[w] ?? w}</option>)}</select></Field>
            <Field errors={shown('modelProfile')} id="modelProfile" label="Model profile"><select id="modelProfile" value={form.modelProfile} onChange={e => set('modelProfile', e.target.value)}>{config.modelProfiles.map(w => <option key={w} value={w}>{w}</option>)}</select></Field>
          </div>
        </section>

        {server.length > 0 && <div className="banner bad" role="alert" data-testid="server-errors">{server.map((m, i) => <p key={i}>{m}</p>)}</div>}
        <div className="actions">
          <button type="submit" className="primary" disabled={!canSubmit} data-testid="submit-brief">{busy ? 'Starting…' : 'Start run'}</button>
          {!checked.ok && <span className="muted" data-testid="blocked-reason">Fix {errors.length} {errors.length === 1 ? 'problem' : 'problems'} to continue.</span>}
          {checked.ok && (auth.analyst.trim() === '' || auth.token.trim() === '') && <span className="muted" data-testid="blocked-reason">Enter the analyst name and approver token above.</span>}
        </div>
      </form>

      {recent.length > 0 && (
        <section className="card">
          <h2>Recent runs</h2>
          <ul className="runs">{recent.map(r => <li key={r.id}><a href={`#/runs/${r.id}`}>{r.theme || r.id}</a> <span className={`pill ${r.status}`}>{r.status.replaceAll('_', ' ')}</span></li>)}</ul>
        </section>
      )}
    </div>
  );
}
