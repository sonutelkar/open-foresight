import { useCallback, useEffect, useMemo, useState } from 'react';
import { frameworkToDraft, validateFramework, type Framework, type FrameworkError, type Kpi, type SourceId } from '@open-foresight/core';
import { ApiError, approveRun, getRun, type Auth, type Config, type RunDetail } from './api';

const stages = [['draft', 'Brief'], ['universe_built', 'Universe'], ['designing', 'Designer'], ['awaiting_kpi_approval', 'KPI approval'], ['prescreening', 'Scoring']] as const;
const waiting = new Set(['draft', 'universe_built', 'designing']);
const methodLabel: Record<string, string> = { quant: 'Quant', extract_then_quant: 'Extract then quant', judgement: 'Judgement' };
const levels = ['0', '1', '2', '3', '4'] as const;
const time = (iso: string) => new Date(iso).toLocaleString();

export function RunPage({ id, config, auth }: { id: string; config: Config; auth: Auth }) {
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
  const index = stages.findIndex(([s]) => s === run.status);

  return (
    <div className="page wide">
      <header className="page-head">
        <p className="crumb"><a href="#/">New run</a> / Run {run.id.slice(0, 8)}</p>
        <h1>{run.settings.brief ? run.settings.brief.slice(0, 90) + (run.settings.brief.length > 90 ? '…' : '') : 'Theme run'}</h1>
        <ol className="stepper" aria-label="Run progress">
          {stages.map(([s, label], i) => <li key={s} className={i < index ? 'done' : i === index ? 'now' : ''} aria-current={i === index ? 'step' : undefined}>{label}</li>)}
        </ol>
        <p className="muted" data-testid="run-status">Status: <strong>{run.status.replaceAll('_', ' ')}</strong>{run.settings.universe?.status === 'placeholder' ? ' · the universe stage is a placeholder until the orchestration ticket' : ''}</p>
      </header>

      {waiting.has(run.status) && <div className="banner info" data-testid="designing"><span className="spinner" aria-hidden /> The Designer is drafting the framework. This usually takes about a minute.</div>}
      {run.status === 'failed' && <div className="banner bad" role="alert" data-testid="run-failed"><strong>The run failed.</strong>{(run.settings.designError ?? []).map((m, i) => <p key={i}>{m}</p>)}</div>}
      {run.status === 'awaiting_kpi_approval' && run.draft && <Gate run={run} config={config} auth={auth} onApproved={refresh} />}
      {run.versions.length > 0 && <Approved run={run} />}
    </div>
  );
}

type Anyk = Record<string, any>;

function Gate({ run, config, auth, onApproved }: { run: RunDetail; config: Config; auth: Auth; onApproved: () => Promise<unknown> }) {
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

  const edit = (fn: (draftFramework: Framework) => void) => setFramework(f => { const next = structuredClone(f); fn(next); return next; });
  const kpi = framework.kpis[selected] as (Kpi & Anyk) | undefined;
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
        <h2>KPI framework</h2>
        <p className="muted">Drafted by <code>{draft.model}</code> with prompt <code>{draft.promptVersion}</code>. Edit weights, rubrics, sources and exclusions, then approve. The approved framework is frozen as a version.</p>
        <p className="rationale">{framework.rationale}</p>
        <ul className="subthemes">{framework.subThemes.map(s => <li key={s.id}><strong>{s.name}</strong> {s.description}</li>)}</ul>
      </section>

      <div className="gate-layout">
        <section className="card">
          <table className="kpis">
            <thead><tr><th>KPI</th><th>Method</th><th>Sources</th><th className="num">Weight %</th><th>Gate</th></tr></thead>
            <tbody>
              {framework.kpis.map((k, i) => {
                const bad = kpiErrors(i).length > 0;
                return (
                  <tr key={k.id} className={`${i === selected ? 'selected' : ''} ${bad ? 'has-error' : ''}`} data-testid={`kpi-row-${k.id}`} onClick={() => setSelected(i)}>
                    <td><button type="button" className="link" onClick={() => setSelected(i)} aria-label={`Edit ${k.name}`}>{k.name}</button>{bad && <span className="dot" title="Needs attention" />}</td>
                    <td><span className={`badge ${k.method}`}>{methodLabel[k.method]}</span></td>
                    <td className="small">{k.sources.join(', ')}</td>
                    <td className="num"><input aria-label={`Weight for ${k.name}`} data-testid={`weight-${k.id}`} className="weight" inputMode="numeric" value={Number.isFinite(k.weightPercent) ? String(k.weightPercent) : ''} onClick={e => e.stopPropagation()} onChange={e => setK(i, { weightPercent: e.target.value.trim() === '' ? Number.NaN : Number(e.target.value) })} /></td>
                    <td><input type="checkbox" aria-label={`Gate: ${k.name}`} data-testid={`gate-${k.id}`} checked={k.isGate} onClick={e => e.stopPropagation()} onChange={e => setK(i, { isGate: e.target.checked })} /></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr><td colSpan={3}>Total</td><td className="num"><span className={total === 100 ? 'chip ok' : 'chip warn'} data-testid="weight-total">{total}%</span></td><td /></tr></tfoot>
          </table>
          <div className="field">
            <label htmlFor="exclusions">Exclusions</label>
            <textarea id="exclusions" rows={2} value={exclusions} onChange={e => setExclusions(e.target.value)} />
            <p className="hint">Tickers, sectors or keywords to drop. Saved with the approved version.</p>
          </div>
        </section>

        <aside className="card editor" aria-label="KPI editor">
          {kpi ? <KpiEditor kpi={kpi} index={selected} config={config} errors={kpiErrors(selected)} setK={setK} edit={edit} /> : <p className="muted">Select a KPI.</p>}
        </aside>
      </div>

      <section className="card approve" data-testid="approve-card">
        {general.length > 0 && <ul className="problems" role="alert" data-testid="problems">{general.map((e, i) => <li key={i} data-code={e.code}>{e.message}</li>)}</ul>}
        {errors.length > 0 && general.length === 0 && <p className="warn" data-testid="problems">Fix the highlighted KPIs to approve.</p>}
        <div className="field"><label htmlFor="reason">Note for the audit trail (optional)</label><input id="reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} /></div>
        {server.length > 0 && <div className="banner bad" role="alert" data-testid="server-errors">{server.map((m, i) => <p key={i}>{m}</p>)}</div>}
        <div className="actions">
          <button type="button" className="primary" disabled={!checked.ok || !hasAuth || busy} onClick={() => void approve()} data-testid="approve-button">{busy ? 'Approving…' : 'Approve and score'}</button>
          <span className="muted" data-testid="approve-hint">{!checked.ok ? `${errors.length} ${errors.length === 1 ? 'problem blocks' : 'problems block'} approval.` : !hasAuth ? 'Enter the analyst name and approver token above.' : edited ? 'You edited the framework. The approved version will record that.' : 'Approving as drafted.'}</span>
        </div>
      </section>
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
      <h2>{kpi.name}</h2>
      <p className="muted"><span className={`badge ${kpi.method}`}>{methodLabel[kpi.method]}</span> <code>{kpi.id}</code></p>
      {errors.length > 0 && <ul className="problems" role="alert" data-testid="kpi-problems">{errors.map((e, i) => <li key={i} data-code={e.code}>{e.message}</li>)}</ul>}
      <div className="field"><label htmlFor="kpi-name">Name</label><input id="kpi-name" value={kpi.name} onChange={e => setK(index, { name: e.target.value })} /></div>
      <div className="field"><label htmlFor="kpi-definition">Definition</label><textarea id="kpi-definition" rows={3} value={kpi.definition} onChange={e => setK(index, { definition: e.target.value })} /></div>
      {kpi.method === 'quant' && <p className="muted">Computed in code by <code>{kpi.quantQuery}</code>: {config.quantFunctions[kpi.quantQuery as string] ?? ''}</p>}
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
        <fieldset><legend>Rubric</legend>
          {levels.map(l => <div className="field" key={l}><label htmlFor={`rubric-level-${l}`}>Level {l}</label><textarea id={`rubric-level-${l}`} data-testid={`rubric-level-${l}`} rows={2} value={kpi.rubric.levels[l]} onChange={e => patchRubric(l, e.target.value)} /></div>)}
          <div className="field"><label htmlFor="rubric-unknown">When to answer unknown</label><textarea id="rubric-unknown" data-testid="rubric-unknown" rows={2} value={kpi.rubric.unknown} onChange={e => patchRubric('unknown', e.target.value)} /></div>
        </fieldset>
      )}
      <fieldset><legend>Sources</legend><div className="row">{config.availableSources.map(s => <label key={s} className="check" title={config.sources[s]}><input type="checkbox" checked={chosen.includes(s)} onChange={() => toggleSource(s)} />{s}</label>)}</div></fieldset>
      <div className="field narrow"><label htmlFor="kpi-lookback">Lookback, days</label><input id="kpi-lookback" inputMode="numeric" value={Number.isFinite(kpi.lookbackDays) ? String(kpi.lookbackDays) : ''} onChange={e => setK(index, { lookbackDays: e.target.value.trim() === '' ? Number.NaN : Number(e.target.value) })} /></div>
    </div>
  );
}

function Approved({ run }: { run: RunDetail }) {
  const v = run.versions[run.versions.length - 1]!;
  const decision = run.decisions.find(d => d.target === v.id);
  return (
    <section className="card approved" data-testid="approved">
      <h2>Framework approved</h2>
      <p>Version <strong>{v.version}</strong> was approved by <strong data-testid="approved-by">{v.approvedBy}</strong> on {time(v.createdAt)}. {v.edited ? 'The approved framework differs from the draft.' : 'It was approved as drafted.'}</p>
      <dl className="facts">
        <div><dt>Version id</dt><dd><code data-testid="version-id">{v.id}</code></dd></div>
        <div><dt>Decision</dt><dd data-testid="decision">{decision ? `${decision.userId} ${decision.action}d ${decision.stage.replaceAll('_', ' ')}${decision.reason ? ` · ${decision.reason}` : ''}` : 'not found'}</dd></div>
        <div><dt>Run status</dt><dd>{run.status.replaceAll('_', ' ')}</dd></div>
      </dl>
      <table className="kpis frozen"><thead><tr><th>KPI</th><th>Method</th><th className="num">Weight %</th></tr></thead>
        <tbody>{v.framework.kpis.map(k => <tr key={k.id}><td>{k.name}{k.isGate ? <span className="badge gate">Gate</span> : null}</td><td><span className={`badge ${k.method}`}>{methodLabel[k.method]}</span></td><td className="num">{k.weightPercent}</td></tr>)}</tbody>
      </table>
      {v.exclusions.length > 0 && <p className="muted">Exclusions: {v.exclusions.join(', ')}</p>}
    </section>
  );
}
