import { useState } from 'react';
import { basketView, formatScore, levelText, reviewLimitation } from '@open-foresight/core';
import { getEvidence, type Citation, type KpiEvidence, type MemberEvidence, type RunDetail } from './api';

type Basket = NonNullable<RunDetail['basket']>;
type Member = Basket['members'][number];

export function BasketSection({ run }: { run: RunDetail }) {
  const view = basketView(run, run.basket);
  if (view === 'failed' || view === 'pending' || !run.basket) return null;
  const basket = run.basket, f = basket.funnel;
  return (
    <section className="card" data-testid="basket">
      <div className="card-head">
        <div><p className="card-title">Provisional basket</p><p className="card-sub">Unknown KPIs are treated as {basket.unknownMode === 'strict' ? 'level 0' : 'missing, and the other weights are renormalised'}.</p></div>
        <span className="pill warn">Provisional</span>
      </div>
      <div className="banner info" data-testid="review-limitation" style={{ marginTop: 12 }}>{reviewLimitation}</div>
      <p className="muted tnum" data-testid="funnel" style={{ margin: '12px 0' }}>{f.universe} listings, {f.screened} screened in, {f.candidates} scored, {f.gateFailed} failed the gate, {f.gateUnknown} had no evidence on the gate KPI, {f.thinEvidence ? `${f.thinEvidence} had too little known KPI weight, ` : ''}{f.zeroScore} scored zero, {f.selected} selected{f.belowCutoff ? `, ${f.belowCutoff} below the cutoff` : ''}.</p>
      {basket.cap.relaxed && <div className="banner info" data-testid="cap-relaxed">Only {f.selected} names qualified, so the per-name cap of {basket.cap.requestedPercent}% was raised to {basket.cap.usedPercent}% to reach a total of 100%.</div>}
      {view === 'empty'
        ? <p className="banner warn" data-testid="basket-empty">No names qualified for this basket. See the funnel above for where names dropped out.</p>
        : <table className="frozen basket">
            <thead><tr><th className="rank">#</th><th>Name</th><th className="num">Score</th><th className="num">Confidence</th><th className="num">Weight %</th></tr></thead>
            <tbody>{basket.members.map(m => <MemberRows key={m.symbol} runId={run.id} member={m} />)}</tbody>
          </table>}
    </section>
  );
}

function MemberRows({ runId, member: m }: { runId: string; member: Member }) {
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState<MemberEvidence | null>(null);
  const [error, setError] = useState('');
  function toggle() {
    const next = !open; setOpen(next);
    if (next && !evidence) getEvidence(runId, m.symbol).then(setEvidence).catch(e => setError(e instanceof Error ? e.message : 'Could not load the evidence'));
  }
  return (
    <>
      <tr data-testid={`basket-row-${m.symbol}`}>
        <td className="rank">{m.rank}</td>
        <td><button type="button" className="link" aria-expanded={open} onClick={toggle} data-testid={`evidence-toggle-${m.symbol}`}>{m.name}</button> <span className="muted">{m.symbol}</span></td>
        <td className="num" data-testid={`score-${m.symbol}`}>{formatScore(m.score)}</td>
        <td className="num">{m.confidence.toFixed(2)}</td>
        <td className="num">{m.weightPercent.toFixed(2)}{m.atCap ? ' (cap)' : ''}</td>
      </tr>
      {open && (
        <tr data-testid={`evidence-${m.symbol}`}><td /><td colSpan={4}>
          {m.unknownWeight > 0 && <p className="muted">{Math.round(m.unknownWeight * 100)}% of the KPI weight was unknown for this name.{m.capAdjustment < 0 ? ` The unknown cap lowered its score by ${Math.abs(m.capAdjustment).toFixed(3)}.` : ''}</p>}
          {error && <p className="warn" role="alert">{error}</p>}
          {!error && !evidence && <p className="muted">Loading the evidence…</p>}
          {evidence?.kpis.map(k => <KpiBlock key={k.kpiId} kpi={k} contribution={m.contributions.find(c => c.kpiId === k.kpiId)} />)}
        </td></tr>
      )}
    </>
  );
}

function KpiBlock({ kpi: k, contribution }: { kpi: KpiEvidence; contribution: Member['contributions'][number] | undefined }) {
  return (
    <article className="kpi" data-testid={`kpi-evidence-${k.kpiId}`}>
      <div className="kpi-head"><div className="kpi-title"><strong>{k.name}</strong> <span className="badge">{k.method.replaceAll('_', ' ')}</span></div>
        <span className="tnum">{k.scored ? levelText(k.level ?? 'unknown') : 'Not scored'}{contribution ? ` · adds ${contribution.contribution.toFixed(3)}` : ''}</span></div>
      {k.adjustments?.map(a => <p key={a.code} className="warn" data-testid="adjustment">{a.message}</p>)}
      {k.scored && k.rationale && <p className="rationale-text">{k.rationale}</p>}
      {k.extractedValue != null && <p className="muted">Extracted value {k.extractedValue}{k.unit ? ` ${k.unit}` : ''}</p>}
      {k.quantValue != null && <p className="muted">Computed value {k.quantValue}</p>}
      {k.conflicts && k.conflicts.length > 0 && <p className="warn">Conflicts: {k.conflicts.join('; ')}</p>}
      {k.citations?.map(c => <Quote key={c.evidenceId} c={c} />)}
      {k.scored && k.method !== 'quant' && (k.citations?.length ?? 0) === 0 && <p className="muted">No passage supported a score.</p>}
    </article>
  );
}

function Quote({ c }: { c: Citation }) {
  return (
    <blockquote className="quote" data-testid="quote" data-verified={c.quoteVerified}>
      <p>“{c.quote}”</p>
      <footer className="muted">{c.section}, available {c.availableOn} · {c.sourceUrl ? <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener" data-testid="source-link">{c.sourceLabel ?? 'Source'}</a> : 'source not in the local store'}{c.quoteVerified ? '' : ' · not found verbatim in the stored passage'}</footer>
    </blockquote>
  );
}
