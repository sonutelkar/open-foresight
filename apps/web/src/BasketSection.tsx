import { useEffect, useState } from 'react';
import { basketView, formatScore, levelText, reviewLimitation } from '@open-foresight/core';
import { getEvidence, type Citation, type EvidenceSummary, type KpiEvidence, type MemberEvidence, type RunDetail } from './api';

type Basket = NonNullable<RunDetail['basket']>;
type Member = Basket['members'][number];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const levels = ['0', '1', '2', '3', '4'] as const;

/** A drawn chevron. It turns to point down when its row is open. */
function Chevron({ open }: { open: boolean }) {
  return <svg className={`chevron${open ? ' open' : ''}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden focusable="false"><path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function Tick() {
  return <svg className="tick" width="13" height="13" viewBox="0 0 14 14" aria-hidden focusable="false"><path d="M3 7.5l2.6 2.6L11 4.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function BasketSection({ run }: { run: RunDetail }) {
  const view = basketView(run, run.basket);
  if (view === 'failed' || view === 'pending' || !run.basket) return null;
  const basket = run.basket, f = basket.funnel;
  return (
    <section className="card" data-testid="basket">
      <div className="card-head">
        <div><h2 className="card-title">Provisional basket</h2><p className="card-sub">Unknown KPIs are treated as {basket.unknownMode === 'strict' ? 'level 0' : 'missing, and the other weights are renormalised'}.</p></div>
        <span className="pill warn">Provisional</span>
      </div>
      <div className="banner info" data-testid="review-limitation" style={{ marginTop: 12 }}>{reviewLimitation}</div>
      <p className="muted tnum" data-testid="funnel" style={{ margin: '12px 0' }}>{f.universe} listings, {f.screened} screened in, {f.candidates} scored, {f.gateFailed} failed the gate, {f.gateUnknown} had no evidence on the gate KPI, {f.thinEvidence ? `${f.thinEvidence} had too little known KPI weight, ` : ''}{f.zeroScore} scored zero, {f.selected} selected{f.belowCutoff ? `, ${f.belowCutoff} below the cutoff` : ''}.</p>
      {basket.cap.relaxed && <div className="banner info" data-testid="cap-relaxed">Only {f.selected} names qualified, so the per-name cap of {basket.cap.requestedPercent}% was raised to {basket.cap.usedPercent}% to reach a total of 100%.</div>}
      {view === 'empty'
        ? <p className="banner warn" data-testid="basket-empty">No names qualified for this basket. See the funnel above for where names dropped out.</p>
        : <table className="frozen basket">
            <thead><tr><th className="rank">#</th><th>Name</th><th className="wide">Evidence</th><th className="num">Score</th><th className="num">Confidence</th><th className="num">Weight %</th></tr></thead>
            <tbody>{basket.members.map(m => <MemberRows key={m.symbol} runId={run.id} member={m} startOpen={m.rank === 1} />)}</tbody>
          </table>}
    </section>
  );
}

/** What a row says about its evidence before it is opened: how many quotes stand behind it, and anything that should make a reader look. */
function Tally({ e }: { e: EvidenceSummary }) {
  if (e.quotes === 0) return <span className="tally none">No quotes</span>;
  return (
    <span className="tally" data-testid="tally">
      <span>{plural(e.quotes, 'quote')}</span>
      {e.unverified > 0 && <span className="flag warn">{e.unverified} not verbatim</span>}
      {e.lowered > 0 && <span className="flag warn">{e.lowered} lowered</span>}
      {e.unknownKpis > 0 && <span className="flag">{e.unknownKpis} unknown</span>}
    </span>
  );
}

function MemberRows({ runId, member: m, startOpen }: { runId: string; member: Member; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [evidence, setEvidence] = useState<MemberEvidence | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || evidence) return;
    let live = true;
    setError('');
    getEvidence(runId, m.symbol).then(e => { if (live) setEvidence(e); }).catch(e => { if (live) setError(e instanceof Error ? e.message : 'Could not load the evidence'); });
    return () => { live = false; };
  }, [open, evidence, runId, m.symbol, attempt]);
  const panel = `evidence-${m.symbol}`;
  return (
    <>
      <tr className={`member${open ? ' open' : ''}`} data-testid={`basket-row-${m.symbol}`} onClick={() => setOpen(o => !o)}>
        <td className="rank">{m.rank}</td>
        <td>
          <button type="button" className="disclose" aria-expanded={open} aria-controls={panel} onClick={e => { e.stopPropagation(); setOpen(o => !o); }} data-testid={`evidence-toggle-${m.symbol}`}>
            <Chevron open={open} /><span className="name">{m.name}</span>
          </button>
          <span className="muted sym">{m.symbol}</span>
          <div className="narrow-only"><Tally e={m.evidence} /></div>
        </td>
        <td className="wide"><Tally e={m.evidence} /></td>
        <td className="num" data-testid={`score-${m.symbol}`}>{formatScore(m.score)}</td>
        <td className="num">{m.confidence.toFixed(2)}</td>
        <td className="num">{m.weightPercent.toFixed(2)}{m.atCap ? ' (cap)' : ''}</td>
      </tr>
      {open && (
        <tr id={panel} className="ledger-wrap" data-testid={`evidence-${m.symbol}`}><td /><td colSpan={5}>
          {m.unknownWeight > 0 && <p className="muted ledger-note">{Math.round(m.unknownWeight * 100)}% of the KPI weight was unknown for this name.{m.capAdjustment < 0 ? ` The unknown cap lowered its score by ${Math.abs(m.capAdjustment).toFixed(3)}.` : ''}</p>}
          {error && <p className="ledger-error" role="alert">{error} <button type="button" className="textbtn" onClick={() => setAttempt(a => a + 1)}>Try again</button></p>}
          {!error && !evidence && <p className="muted ledger-note">Loading the evidence…</p>}
          {evidence && <div className="ledger">{evidence.kpis.map(k => <KpiBlock key={k.kpiId} kpi={k} contribution={m.contributions.find(c => c.kpiId === k.kpiId)} />)}</div>}
        </td></tr>
      )}
    </>
  );
}

/** Five marks for levels 0 to 4, filled up to the level. Unknown shows five empty marks. */
function LevelMeter({ level }: { level?: string }) {
  const n = level !== undefined && level !== 'unknown' ? Number(level) : -1;
  return <span className="meter" role="img" aria-label={level === undefined ? 'not scored' : level === 'unknown' ? 'unknown' : `level ${level} of 4`}>{levels.map(l => <i key={l} className={Number(l) <= n && n >= 0 ? 'on' : ''} />)}</span>;
}

function KpiBlock({ kpi: k, contribution }: { kpi: KpiEvidence; contribution: Member['contributions'][number] | undefined }) {
  return (
    <section className="ledger-row" data-testid={`kpi-evidence-${k.kpiId}`}>
      <header>
        <div className="ledger-title"><h3>{k.name}</h3><span className="badge">{k.method.replaceAll('_', ' ')}</span></div>
        <div className="ledger-level"><LevelMeter level={k.scored ? k.level : undefined} /><span className="tnum">{k.scored ? levelText(k.level ?? 'unknown') : 'Not scored'}{contribution ? ` · adds ${contribution.contribution.toFixed(3)}` : ''}</span></div>
      </header>
      {k.adjustments?.map(a => <p key={a.code} className="adjust" data-testid="adjustment"><strong>{a.from === a.to ? 'Check' : 'Lowered'}.</strong> {a.message}</p>)}
      {k.scored && k.rationale && <p className="rationale-text">{k.rationale}</p>}
      {k.extractedValue != null && <p className="muted">Extracted value {k.extractedValue}{k.unit ? ` ${k.unit}` : ''}</p>}
      {k.quantValue != null && <p className="muted">Computed value {k.quantValue}</p>}
      {k.conflicts && k.conflicts.length > 0 && <p className="warn">Conflicts: {k.conflicts.join('; ')}</p>}
      {k.citations?.map(c => <Quote key={c.evidenceId} c={c} />)}
      {k.scored && k.method !== 'quant' && (k.citations?.length ?? 0) === 0 && <p className="muted">No passage supported a score.</p>}
    </section>
  );
}

function Quote({ c }: { c: Citation }) {
  return (
    <figure className={`quote${c.quoteVerified ? '' : ' unverified'}`} data-testid="quote" data-verified={c.quoteVerified}>
      <blockquote>{c.quote}</blockquote>
      <figcaption>
        <span className={`verdict${c.quoteVerified ? ' ok' : ' warn'}`}>{c.quoteVerified ? <><Tick /> Found word for word</> : 'Not found word for word in the stored text'}</span>
        <span className="prov">{c.sourceLabel ?? 'source not in the local store'} · {c.section} · available {c.availableOn} · passage chars {c.startOffset.toLocaleString('en-GB')} to {c.endOffset.toLocaleString('en-GB')}</span>
        {c.sourceUrl && <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener" data-testid="source-link">Open the source</a>}
      </figcaption>
    </figure>
  );
}
