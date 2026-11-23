import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BasketSection, KpiBlock } from './BasketSection';
import type { KpiEvidence, RunDetail } from './api';

const member = (symbol: string, routes: Array<'jev' | 'luna-fallback' | undefined>): NonNullable<RunDetail['basket']>['members'][number] => ({
  evidence: { kpis: 2, quotes: 3, unverified: 0, unknownKpis: 0, lowered: 0 }, rank: 1, symbol, name: `${symbol} Inc`, score: 0.5, confidence: 0.6, weightPercent: 50, atCap: false, unknownWeight: 0, capAdjustment: 0,
  contributions: routes.map((route, i) => ({ kpiId: `k${i}`, level: '2', ...(route ? { route } : {}), weight: 0.5, contribution: 0.25 })),
});
const run = (members: ReturnType<typeof member>[], fallbackNote?: string): RunDetail => ({
  id: 'r', status: 'done', createdAt: '', frameworkVersion: 'v', settings: {}, draft: null, attempts: [], history: [], decisions: [], versions: [], universe: { total: 1, included: 1, withFilings: 1 },
  basket: { status: 'provisional', unknownMode: 'lenient', ...(fallbackNote ? { fallbackNote } : {}), funnel: { universe: 1, screened: 1, candidates: 1, gateFailed: 0, gateUnknown: 0, zeroScore: 0, eligible: 1, selected: 1, belowCutoff: 0 }, cap: { requestedPercent: 5, usedPercent: 5, relaxed: false }, members },
});

describe('basket view and the Luna fallback flag', () => {
  it('shows the fallback count on the name and the provisional note, and neither without a fallback', () => {
    const flagged = renderToStaticMarkup(<BasketSection run={run([member('AAA.US', ['jev', 'luna-fallback', 'luna-fallback'])], 'Luna fallback scores are provisional.')} />);
    expect(flagged).toContain('data-testid="fallback-flag"');
    expect(flagged).toContain('2 Luna fallback');
    expect(flagged).toContain('Luna fallback scores are provisional.');
    const plain = renderToStaticMarkup(<BasketSection run={run([member('AAA.US', [undefined, undefined])])} />);
    expect(plain).not.toContain('fallback');
  });
});

describe('KPI evidence route badge', () => {
  const kpi = (over: Partial<KpiEvidence>): KpiEvidence => ({ kpiId: 'k', name: 'Storage', method: 'judgement', scored: true, level: '3', citations: [], ...over });
  it('marks a fallback score as provisional and says why Jev did not answer', () => {
    const html = renderToStaticMarkup(<KpiBlock kpi={kpi({ route: 'luna-fallback', jevAnswer: { level: 'unknown', reason: 'unknown_rule', answer: { known: 0.3 } } })} contribution={undefined} />);
    expect(html).toContain('Luna fallback, provisional');
    expect(html).toContain('Jev answered unknown (unknown rule, probability known 0.30)');
  });
  it('marks a Jev score, says it cites nothing, and shows no badge on an Analyst score', () => {
    const jev = renderToStaticMarkup(<KpiBlock kpi={kpi({ route: 'jev' })} contribution={undefined} />);
    expect(jev).toContain('data-testid="route-badge"');
    expect(jev).toContain('Jev cites no passages.');
    expect(renderToStaticMarkup(<KpiBlock kpi={kpi({})} contribution={undefined} />)).not.toContain('route-badge');
  });
});
