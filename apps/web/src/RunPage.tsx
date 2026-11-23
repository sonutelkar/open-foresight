import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeEdits, diffFramework, frameworkToDraft, validateFramework, type Framework, type FrameworkError, type Kpi, type SourceId } from '@open-foresight/core';
import { BasketSection } from './BasketSection';
import { ApiError, approveRun, getRun, type Auth, type Config, type RunDetail } from './api';

const stages = ['Brief', 'Universe', 'Designer', 'KPI approval', 'Scoring', 'Basket'] as const;
const stepOf: Record<string, number> = { draft: 0, universe_built: 1, designing: 2, awaiting_kpi_approval: 3, prescreening: 4, analysing: 4, packaging: 4, done: 5 };
/** The statuses where the worker is busy, so the page keeps polling. */
const waiting = new Set(['draft', 'universe_built', 'designing', 'prescreening', 'analysing', 'packaging']);
const methodLabel: Record<string, string> = { quant: 'Quant', extract_then_quant: 'Extract then quant', judgement: 'Judgement' };
const statusLabel: Record<string, string> = { draft: 'Starting', universe_built: 'Starting', designing: 'Designing', awaiting_kpi_approval: 'Awaiting your approval', prescreening: 'Scoring', analysing: 'Scoring', packaging: 'Building the basket', done: 'Provisional basket ready', failed: 'Failed' };
const statusTone: Record<string, string> = { awaiting_kpi_approval: 'warn', prescreening: 'info', analysing: 'info', packaging: 'info', done: 'ok', failed: 'bad', designing: 'info', draft: 'info', universe_built: 'info' };
const levels = ['0', '1', '2', '3', '4'] as const;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const time = (iso: string) => new Date(iso).toLocaleString();
const shortTheme = (brief?: string) => { if (!brief) return 'Theme run'; const first = brief.split(/[.:]/)[0]?.trim() ?? brief; return first.length > 56 ? `${first.slice(0, 56)}…` : first; };

export function RunPage({ id, config, auth, onAuth }: { id: string; config: Config; auth: Auth; onAuth: (patch: Partial<Auth>) => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(() => getRun(id).then(setRun).catch(e => setError(e instanceof Error ? e.message : 'Could not load the run')), [id]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!run || !waiting.has(run.status)) return;
    const t = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(t);
  }, [run, refresh]);

  if (error) return <div className="page"><div className="banner bad" role="alert">{error}</div></div>;
  if (!run) return <div className="page"><p className="muted">Loading…</p></div>;
  const index = stepOf[run.status] ?? -1;

  return (
    <div className="page wide">
      <header className="page-head">
        <p className="crumb"><a href="#/">New run</a> / Run {run.id.slice(0, 8)}</p>
        <div className="card-head">
          <div>
            <p className="eyebrow">KPI framework</p>
            <h1>{shortTheme(run.settings.brief)}</h1>
          </div>
          <span className={`pill ${statusTone[run.status] ?? ''}`} data-testid="status-pill">{statusLabel[run.status] ?? run.status}</span>
        </div>
        <ol className="steps" aria-label="Run progress">
          {stages.map((label, i) => <li key={label} className={i < index || run.status === 'done' ? 'done' : i === index ? 'now' : ''} aria-current={i === index ? 'step' : undefined}><span className="dot" />{label}</li>)}
        </ol>
        <p className="muted" data-testid="run-status" style={{ marginTop: 10 }}>Status: <strong>{run.status.replaceAll('_', ' ')}</strong>{run.universe.total > 0 ? ` · ${run.universe.included} of ${run.universe.total} listings passed the universe screen` : ''}</p>
      </header>

      {['draft', 'universe_built', 'designing'].includes(run.status) && <div className="banner info" data-testid="designing"><span className="spinner" aria-hidden /> The Designer is drafting the framework. This usually takes about a minute.</div>}
      {['prescreening', 'analysing', 'packaging'].includes(run.status) && <div className="banner info" data-testid="scoring"><span className="spinner" aria-hidden /> The worker is scoring every name against the approved KPIs. This takes a few minutes for 50 names.</div>}
      {run.status === 'failed' && <div className="banner bad" role="alert" data-testid="run-failed"><strong>The run failed.</strong>{[run.settings.failure?.message, ...(run.settings.designError ?? [])].filter(Boolean).map((m, i) => <p key={i}>{m}</p>)}</div>}
      {run.status === 'awaiting_kpi_approval' && run.draft && <Gate run={run} config={config} auth={auth} onAuth={onAuth} onApproved={refresh} />}
      <BasketSection run={run} />
      {run.versions.length > 0 && <Approved run={run} />}
    </div>
  );
}

type Anyk = Record<string, any>;

function Gate({ run, config, auth, onAuth, onApproved }: { run: RunDetail; config: Config; auth: Auth; onAuth: (patch: Partial<Auth>) => void; onApproved: () => Promise<unknown> }) {
  const draft = run.draft!;
  const [framework, setFramework] = useState<Framework>(() => structuredClone(draft.framework));
  const [exclusions, setExclusions] = useState((run.settings.exclusions ?? []).join('\n'));
  const [selected, setSelected] = useState(0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string[]>([]);

  const checked = useMemo(() => validateFramework(frameworkToDraft(framework), { availableSources: config.availableSources as SourceId[] }), [framework, config.availableSources]);
  const errors: FrameworkError[] = checked.ok ? [] : checked.errors;
  const total = framework.kpis.reduce((s, k) => s + (Number.isFinite(k.weightPercent) ? k.weightPercent : 0), 0);
  const kpiErrors = (i: number) => errors.filter(e => new RegExp(`^kpis\\.${i}(\\.|$)`).test(e.path));
  const general = errors.filter(e => !/^kpis\.\d+/.test(e.path));
  const hasAuth = auth.analyst.trim() !== '' && auth.token.trim() !== '';
  const edited = JSON.stringify(framework) !== JSON.stringify(draft.framework);
  const edits = useMemo(() => diffFramework(draft.framework, framework), [draft.framework, framework]);
  const gates = framework.kpis.filter(k => k.isGate).length;
  const version = run.versions.length + 1;
  const reset = () => { setFramework(structuredClone(draft.framework)); setExclusions((run.settings.exclusions ?? []).join('\n')); setServer([]); };

  const edit = (fn: (draftFramework: Framework) => void) => setFramework(f => { const next = structuredClone(f); fn(next); return next; });
  const setK = (i: number, patch: Anyk) => edit(f => { Object.assign(f.kpis[i] as Anyk, patch); });

  async function approve() {
    setBusy(true); setServer([]);
    try {
      await approveRun(run.id, { framework, exclusions: exclusions.split(/[\n,]/).map(s => s.trim()).filter(Boolean), reason: reason.trim() || undefined }, auth);
      await onApproved();
    } catch (e) {
      setServer(e instanceof ApiError ? (e.body.errors?.map(x => x.message) ?? [e.message]) : ['The approval failed']);
    } finally { setBusy(false); }
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div>
            <p className="card-title">Review and approve the KPIs</p>
            <p className="card-sub">Edit weights, rubrics, sources and exclusions, then approve to start scoring. The approved framework is frozen as a version.</p>
          </div>
          <span className="pill" title="Model and prompt version that drafted this framework">{draft.model.split('/').pop()} · {draft.promptVersion.split(':')[0]}</span>
        </div>
        <div className="weightbar" aria-hidden>{framework.kpis.map((k, i) => <span key={k.id} className={i === selected ? 'sel' : ''} style={{ width: `${Math.max(0, Number.isFinite(k.weightPercent) ? k.weightPercent : 0)}%` }} />)}</div>
        <div className="weightlegend"><span>Weight across {framework.kpis.length} KPIs</span><span className="tnum">{total}% of 100%</span></div>
        <details className="designer">
          <summary>How the Designer reasoned, and the sub-themes</summary>
          <p className="rationale">{framework.rationale}</p>
          <ul className="subthemes">{framework.subThemes.map(s => <li key={s.id}><strong>{s.name}</strong> {s.description}</li>)}</ul>
        </details>
        <div className="kpis">
          {framework.kpis.map((k, i) => {
            const bad = kpiErrors(i).length > 0;
            const open = i === selected;
            return (
              <article key={k.id} className={`kpi ${open ? 'selected' : ''} ${bad ? 'has-error' : ''}`} data-testid={`kpi-row-${k.id}`} onClick={() => setSelected(i)}>
                <div className="kpi-head">
                  <div className="kpi-title">
                    <button type="button" className="link" onClick={() => setSelected(i)} aria-label={`Edit ${k.name}`} aria-expanded={open}>{k.name}</button>
                    <span className={`badge ${k.method}`}>{methodLabel[k.method]}</span>
                    {k.isGate && <span className="badge gate">Gate</span>}
                    {bad && <span className="dot-error" title="Needs attention" />}
                  </div>
                  <div className="kpi-controls" onClick={e => e.stopPropagation()}>
                    <label className="gate-toggle"><input type="checkbox" aria-label={`Gate: ${k.name}`} data-testid={`gate-${k.id}`} checked={k.isGate} onChange={e => setK(i, { isGate: e.target.checked })} />Gate</label>
                    <span className="weight-field"><input aria-label={`Weight for ${k.name}`} data-testid={`weight-${k.id}`} className="weight" inputMode="numeric" value={Number.isFinite(k.weightPercent) ? String(k.weightPercent) : ''} onChange={e => setK(i, { weightPercent: e.target.value.trim() === '' ? Number.NaN : Number(e.target.value) })} />%</span>
                  </div>
                </div>
                <p className="kpi-def">{k.definition}</p>
                <p className="kpi-src">Source: {k.sources.join(', ')} · lookback {Number.isFinite(k.lookbackDays) ? k.lookbackDays : '?'} days</p>
                {open && <div className="kpi-editor" onClick={e => e.stopPropagation()}><KpiEditor kpi={k as Kpi & Anyk} index={i} config={config} errors={kpiErrors(i)} setK={setK} edit={edit} /></div>}
              </article>
            );
          })}
        </div>
      </section>

      <section className="card">
        <div className="grid2">
          <div className="field">
            <label htmlFor="exclusions">Exclusions</label>
            <textarea id="exclusions" rows={2} value={exclusions} onChange={e => setExclusions(e.target.value)} />
            <p className="hint">Tickers, sectors or keywords to drop. Saved with the approved version.</p>
          </div>
          <div className="field"><label htmlFor="reason">Note for the audit trail (optional)</label><textarea id="reason" rows={2} value={reason} onChange={e => setReason(e.target.value)} maxLength={500} /></div>
        </div>
      </section>

      <div data-testid="approve-card">
        {general.length > 0 && <ul className="problems" role="alert" data-testid="problems">{general.map((e, i) => <li key={i} data-code={e.code}>{e.message}</li>)}</ul>}
        {errors.length > 0 && general.length === 0 && <p className="warn" data-testid="problems" style={{ marginBottom: 10 }}>Fix the highlighted KPIs to approve.</p>}
        {server.length > 0 && <div className="banner bad" role="alert" data-testid="server-errors">{server.map((m, i) => <p key={i}>{m}</p>)}</div>}
        <div className="actionbar">
          <div className="total">Total <span className={total === 100 ? 'chip ok' : 'chip warn'} data-testid="weight-total">{total}%</span></div>
          <div className="grow">
            <p className="commit" data-testid="approve-hint">{!checked.ok
              ? `${errors.length} ${errors.length === 1 ? 'problem blocks' : 'problems block'} approval.`
              : <>Approving freezes version {version} with {plural(framework.kpis.length, 'KPI')} and {gates === 0 ? 'no gate' : plural(gates, 'gate')}, then scores up to {plural(run.universe.included, 'name')} with paid model calls. {edited ? `You edited the framework: ${describeEdits(edits) || 'the exclusions or the note changed'}.` : 'No edits to the draft.'}</>}</p>
            {!hasAuth && <div className="who" data-testid="who">
              <label>Analyst <input data-testid="bar-analyst" value={auth.analyst} onChange={e => onAuth({ analyst: e.target.value })} placeholder="Your name" autoComplete="off" maxLength={80} /></label>
              <label>Approver token <input data-testid="bar-token" type="password" value={auth.token} onChange={e => onAuth({ token: e.target.value })} placeholder="From the server" autoComplete="off" /></label>
            </div>}
          </div>
          {edited && <button type="button" className="textbtn" onClick={reset} data-testid="reset-draft">Reset to draft</button>}
          <button type="button" className="primary" disabled={!checked.ok || !hasAuth || busy} onClick={() => void approve()} data-testid="approve-button">{busy ? 'Approving…' : 'Approve and score'}</button>
        </div>
      </div>
    </>
  );
}

function KpiEditor({ kpi, index, config, errors, setK, edit }: { kpi: Kpi & Anyk; index: number; config: Config; errors: FrameworkError[]; setK: (i: number, patch: Anyk) => void; edit: (fn: (f: Framework) => void) => void }) {
  const patchRubric = (key: string, value: string) => edit(f => { const k = f.kpis[index] as Anyk; if (key === 'unknown') k.rubric.unknown = value; else k.rubric.levels[key] = value; });
  const patchThreshold = (n: number, value: string) => edit(f => { (f.kpis[index] as Anyk).thresholds[n] = value.trim() === '' ? Number.NaN : Number(value); });
  const chosen = kpi.sources as string[];
  const toggleSource = (s: string) => setK(index, { sources: chosen.includes(s) ? chosen.filter(x => x !== s) : [...chosen, s] });
  return (
    <div data-testid="kpi-editor">
      {errors.length > 0 && <ul className="problems" role="alert" data-testid="kpi-problems">{errors.map((e, i) => <li key={i} data-code={e.code}>{e.message}</li>)}</ul>}
      <div className="grid2">
        <div className="field"><label htmlFor="kpi-name">Name</label><input id="kpi-name" value={kpi.name} onChange={e => setK(index, { name: e.target.value })} /></div>
        <div className="field narrow"><label htmlFor="kpi-lookback">Lookback, days</label><input id="kpi-lookback" inputMode="numeric" value={Number.isFinite(kpi.lookbackDays) ? String(kpi.lookbackDays) : ''} onChange={e => setK(index, { lookbackDays: e.target.value.trim() === '' ? Number.NaN : Number(e.target.value) })} /></div>
      </div>
      <div className="field"><label htmlFor="kpi-definition">Definition</label><textarea id="kpi-definition" rows={3} value={kpi.definition} onChange={e => setK(index, { definition: e.target.value })} /></div>
      {kpi.method === 'quant' && <p className="muted" style={{ marginBottom: 12 }}>Computed in code by <code>{kpi.quantQuery}</code>: {config.quantFunctions[kpi.quantQuery as string] ?? ''}</p>}
      {kpi.extraction && (
        <div className="field">
          <label htmlFor="kpi-extraction">Number to extract</label>
          <textarea id="kpi-extraction" rows={2} value={kpi.extraction.target} onChange={e => edit(f => { (f.kpis[index] as Anyk).extraction.target = e.target.value; })} />
          <p className="hint">Unit: <strong>{kpi.extraction.unit}</strong>. Thresholds use this unit.</p>
        </div>
      )}
      {kpi.thresholds && (
        <fieldset><legend>Thresholds for levels 1 to 4</legend>
          <div className="row">{kpi.thresholds.map((t: number, n: number) => <input key={n} aria-label={`Threshold ${n + 1}`} className="threshold" inputMode="decimal" value={Number.isFinite(t) ? String(t) : ''} onChange={e => patchThreshold(n, e.target.value)} />)}</div>
        </fieldset>
      )}
      {kpi.rubric && (
        <fieldset><legend>Rubric, level 0 to 4</legend>
          {levels.map(l => <div className="field" key={l}><label htmlFor={`rubric-level-${l}`}>Level {l}</label><textarea id={`rubric-level-${l}`} data-testid={`rubric-level-${l}`} rows={2} value={kpi.rubric.levels[l]} onChange={e => patchRubric(l, e.target.value)} /></div>)}
          <div className="field"><label htmlFor="rubric-unknown">When to answer unknown</label><textarea id="rubric-unknown" data-testid="rubric-unknown" rows={2} value={kpi.rubric.unknown} onChange={e => patchRubric('unknown', e.target.value)} /></div>
        </fieldset>
      )}
      <fieldset><legend>Sources</legend><div className="row">{config.availableSources.map(s => <label key={s} className="check" title={config.sources[s]}><input type="checkbox" checked={chosen.includes(s)} onChange={() => toggleSource(s)} />{s}</label>)}</div></fieldset>
    </div>
  );
}

function Approved({ run }: { run: RunDetail }) {
  const v = run.versions[run.versions.length - 1]!;
  const decision = run.decisions.find(d => d.target === v.id);
  return (
    <section className="card approved" data-testid="approved">
      <div className="card-head">
        <div><p className="card-title">Framework approved</p><p className="card-sub">Version {v.version} is frozen. Scores will reference it.</p></div>
        <span className="pill ok">Approved</span>
      </div>
      <p style={{ marginTop: 12 }}>Version <strong>{v.version}</strong> was approved by <strong data-testid="approved-by">{v.approvedBy}</strong> on {time(v.createdAt)}. {v.edited ? 'The approved framework differs from the draft.' : 'It was approved as drafted.'}</p>
      <dl className="facts">
        <div><dt>Version id</dt><dd><code data-testid="version-id">{v.id}</code></dd></div>
        <div><dt>Decision</dt><dd data-testid="decision">{decision ? `${decision.userId} ${decision.action}d ${decision.stage.replaceAll('_', ' ')}${decision.reason ? ` · ${decision.reason}` : ''}` : 'not found'}</dd></div>
        <div><dt>Run status</dt><dd>{run.status.replaceAll('_', ' ')}</dd></div>
      </dl>
      <table className="frozen"><thead><tr><th>KPI</th><th>Method</th><th className="num">Weight %</th></tr></thead>
        <tbody>{v.framework.kpis.map(k => <tr key={k.id}><td>{k.name}{k.isGate ? <span className="badge gate" style={{ marginLeft: 8 }}>Gate</span> : null}</td><td><span className={`badge ${k.method}`}>{methodLabel[k.method]}</span></td><td className="num">{k.weightPercent}</td></tr>)}</tbody>
      </table>
      {v.exclusions.length > 0 && <p className="muted" style={{ marginTop: 12 }}>Exclusions: {v.exclusions.join(', ')}</p>}
    </section>
  );
}
