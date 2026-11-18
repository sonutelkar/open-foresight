# Open Foresight — thematic investing engine: full scope

Nov 18, 2026 · @Srivatsa Telkar

## Summary

Open Foresight turns an investment theme into an auditable, investable stock basket in hours, using a TypeScript harness around native LLM SDKs, open data first, and an optional EODHD adapter. It mirrors the design of Axyon Foresight: Designer, Analyst and Reviewer roles, two human approval gates, deterministic scoring, and a separate theme discovery agent. No LangChain or LangGraph.

The core idea: **LLMs read and judge; code fetches, computes, scores and decides order.** Every stock score cites evidence, replay from cached responses is a goal, and every human decision is logged.

### Goals

1. Theme brief to approved KPI framework in under 10 minutes.
2. KPI framework to scored, reviewed basket for a \~3,000-stock universe in under 4 hours.
3. Every score traceable to cited, point-in-time evidence and a fixed rubric.
4. The same inputs, model versions and data snapshot replay to the same basket from cached responses. Uncached model outputs may vary.
5. Run on open data alone; EODHD plugs in through the same data-provider interface with no changes elsewhere.
6. Model-agnostic through OpenRouter: one API key and one OpenAI-compatible client reach Anthropic, OpenAI, Google and open-weight models; each agent role picks its model in config.

### Non-goals (v1)

- Portfolio optimisation, order generation or trading.
- Return forecasting. The score measures **thematic exposure**, not expected return.
- Real-time data. Daily or weekly batch is enough.
- Multi-tenant SaaS, billing, SSO. Single team, self-hosted.
- Fully autonomous operation. Humans approve KPIs and final baskets.

### Users

| User | What they do |
| --- | --- |
| Portfolio manager | Writes theme briefs, approves KPI frameworks, finalises baskets |
| Analyst | Reviews flagged names, overrides scores with a reason, reads evidence |
| Engineer (you) | Runs pipelines, adds data sources, tunes prompts, runs evals |
| Compliance / audit (later) | Exports the audit trail for a basket |

### Success criteria

- Analyst agreement on KPI rubric levels: weighted kappa ≥ 0.6 on a labelled set of 200 stock × KPI pairs.
- Run-to-run stability: ≥ 95% of KPI levels identical on a re-run with caching off. Use temperature 0 where the pinned endpoint supports it; otherwise omit it and report the setting.
- Citation validity: 100% of cited evidence IDs exist; ≥ 98% of quoted spans found verbatim in the source.
- Basket recall against a reference list (an existing thematic ETF's holdings within the universe): ≥ 70%, with surplus names explainable.
- Cost per full theme run under a set budget (target: under $30 at default settings; confirm after phase 2).

## Product workflow

A theme run moves through fixed stages with two human gates; the discovery agent runs separately and feeds new theme briefs into the same flow.

&#91;embedded content: run flow · 4 LLM steps, 2 human gates, 1 retry loop\]

The arrows into the store are tool reads filtered by the as-of date; nothing in the run calls the web, and the audit trail records every LLM call and gate decision, not only packaging.

### Run stages

1. **Brief** — user submits a theme brief and settings (below). Status `draft`.
2. **Universe** — code applies hard filters (region, market cap, liquidity) to the security master. No LLM.
3. **Design** — Designer agent drafts sub-themes and a KPI framework. Status `awaiting_kpi_approval`.
4. **Gate 1** — PM edits KPIs, weights, rubrics and exclusions, then approves. The approved framework is frozen and versioned.
5. **Pre-screen** — embedding similarity plus a cheap relevance classifier cut the universe to a shortlist (target 5–10%).
6. **Analyse** — Analyst scores every shortlist stock × KPI pair with cited evidence.
7. **Review** — Reviewer accepts, sends back with critique (max 2 retries) or escalates. Status `awaiting_flag_review`.
8. **Gate 2** — analyst resolves escalations: include, exclude or override with a reason.
9. **Package** — code computes theme scores, applies basket rules and weights, writes explanations. Status `done`.
10. **Export** — CSV/Parquet basket, PDF/HTML report, JSON audit bundle.

### Inputs

| Field | Required | Example |
| --- | --- | --- |
| Theme brief | Yes | "Grid-scale and behind-the-meter energy storage, 5-year horizon, include second-order suppliers, exclude pure EV makers" |
| Keywords | No | BESS, LFP, grid inverter, long-duration storage |
| Seed names | No | Tickers or a CSV of names the PM already believes fit |
| Exclusions | No | Tickers, sectors or keywords to drop |
| Region | Yes | US, Europe, Global developed |
| Min market cap / min ADV | Yes | $1bn / $5m |
| As-of date | Yes (default today) | 2026-11-18; earlier dates for backtests |
| Exposure style | Yes | Pure-play (strict) or Broad (incl. second-order) |
| Basket size, weight cap, weighting | Yes | 40 names, 5% cap, score-weighted |
| Review level | Yes | Approve KPIs + review flags, or approve every stage |
| Model profile | Yes (default set) | "quality" (frontier models), "cheap" (small models), "local" (open-weight) |

### Outputs

- **KPI framework** (gate 1): sub-themes, 3–8 KPIs each with definition, scoring method, sources, anchored rubric 0–4, weight, gate flag.
- **Scored universe**: every shortlisted stock with per-KPI level, extracted value, confidence, citations, rationale, conflicts.
- **Review queue** (gate 2): escalated pairs with the Reviewer's note and conflicting evidence side by side.
- **Basket**: ranked names, theme score, weight, top drivers per name, inclusion reason.
- **Run report**: universe funnel counts, KPI coverage, unknown rates, sector and region mix, overlap with a reference basket, cost and token usage.
- **Audit bundle**: every model call (prompt hash, model ID, params, input evidence IDs, output), data snapshot IDs, human decisions with user and timestamp.
- **Run diff**: names entering and leaving versus the previous run of the same theme.

### Discovery (separate, scheduled)

Weekly job that ingests news, filings, patents, papers and policy, detects new or fast-growing topic clusters, has an agent research the best candidates, and publishes 5–10 ranked candidate themes. A PM clicks **Send to Designer** to start a theme run, or rejects with a reason that is stored as a label.

## UI screens

Three screens carry the whole run: the brief form, the KPI approval at gate 1, and the basket with its review queue at gate 2. These are wireframes for layout and content, not visual design; all company names and numbers are fictional.

### Screen 1: new theme run

&#91;embedded content: screen 1 · new theme run\]

Fields map one to one to the Inputs table above. Dropdown options come from config: model profiles from `config/models.ts`, regions from the security master. Validation: brief at least 20 words, as-of date not in the future, weight cap × number of names ≥ 100%.

### Screen 2: KPI framework approval (gate 1)

&#91;embedded content: screen 2 · KPI framework approval, gate 1\]

Clicking a KPI row opens its full rubric (0–4 plus unknown), sources and lookback for editing. **Approve and score** is blocked until weights sum to 100% and every non-quant KPI has a complete rubric; approval writes a `kpi_framework_versions` row and a `human_decisions` row.

### Screen 3: basket and review queue (gate 2)

&#91;embedded content: screen 3 · basket and review queue, gate 2\]

Clicking any name opens the same drill-down: per-KPI levels, rationale, quotes linked to the source document, and the Reviewer's note. **Override** requires a level and a reason. **Finalise basket** is blocked until every escalated name is resolved; it moves the run to packaging and enables the audit bundle and exports.

## Architecture

One TypeScript monorepo runs the web app, API and workers; Postgres holds all state, and every LLM call goes through a single OpenRouter gateway module. An optional Python sidecar handles statistics the TypeScript ecosystem does poorly (clustering, SHAP, backtests).

&#91;embedded content: system architecture · components and calls\]

External data lands in Postgres first; workers and agents only query that local store, and only the gateway talks to OpenRouter.

### Components

| Component | Role | Tech |
| --- | --- | --- |
| Web app | Brief form, KPI gate, review queue, basket, discovery inbox, audit viewer | Next.js (App Router), React, Tailwind, shadcn/ui, TanStack Table |
| API | REST/RPC for the app, auth, run control | Hono on Node 22, Zod validation |
| Orchestrator | Advances runs through stages; pauses at gates | Plain TypeScript state machine over the `runs` table |
| Workers | Stage jobs: ingest, pre-screen, analyse, review, package, discovery | pg-boss job queue (Postgres-backed, open source) |
| LLM gateway | The only module that calls a model | `openai` SDK with `baseURL` = OpenRouter; Zod schemas |
| Data providers | Uniform interface over open sources and EODHD | One adapter per source, all returning point-in-time records |
| Scrapers | Company IR pages, press releases, policy sites | Crawlee + Playwright, Mozilla Readability, unpdf |
| Store | Runs, scores, evidence, audit, embeddings | Postgres 16 + pgvector, Drizzle ORM |
| Blob store | Raw documents and snapshots | Local disk in dev, MinIO / S3 in prod |
| Analytics sidecar (optional) | HDBSCAN clustering, SHAP, backtests, kappa | Python, FastAPI, called over HTTP by workers |
| Observability | Traces, token cost, latency per call | OpenTelemetry + Langfuse (self-hosted, open source) |

### Harness design (no LangChain, no LangGraph)

- **Runs are rows, not graphs.** A `runs` row has a `status` enum. `advance(runId)` reads the status, runs the next stage, writes the result and the new status. Gates are statuses that only a UI action moves past.
- **Stages are idempotent.** Each stage writes results keyed by `(run_id, stage, item_key)`, so a crashed job re-runs safely.
- **Fan-out = jobs.** Analyse enqueues one job per stock × KPI pair; a stage completes when its job count reaches zero.
- **Agent loop = one function.** `runAgent({model, system, messages, tools, maxTurns, budgetUsd})` calls the model, executes requested tools from a typed registry, appends results, and stops on a final answer, `maxTurns` or budget. Used by the Analyst's evidence gathering and the discovery researcher only.
- **Concurrency and limits.** A per-model token-bucket limiter plus `p-limit` caps in-flight calls; 429s back off with jitter.
- **Cache.** `llm_cache` keyed on `sha256(model, provider, params, system, messages, schema)`; on hit, no call is made. Disabled for stability evals.
- **Prompts as files.** Prompts live in `packages/prompts/*.md` with a version header; the version is stored with every call.

### LLM access: OpenRouter

All model calls use the official `openai` npm package pointed at `https://openrouter.ai/api/v1`, because OpenRouter's request schema closely follows the OpenAI Chat API and normalises it across models ([OpenRouter API overview](https://openrouter.ai/docs/api/reference/overview.md)). Rules for the gateway:

1. **Pin the model and the provider.** Each role's config sets a model slug. At startup the gateway selects the lowest estimated cost eligible ZDR provider using 1,000 input and 1,000 output tokens plus any reported per-request fee and pins that provider in `provider.order` with `allow_fallbacks: false`. The estimate assumes an omitted per-request fee is zero, which is not guaranteed, and excludes other fees. Missing or invalid prompt or completion prices and invalid provided per-request fees exclude a provider; explicit zero prices remain eligible. Ties use provider tag order. Without pinning, the same model can be served by different hosts, which breaks reproducibility. With fallbacks off and `order` set, OpenRouter only tries the listed providers and fails if none can serve ([provider routing](https://openrouter.ai/docs/features/provider-routing)).
2. **Refuse silent parameter drops.** Always send `require_parameters: true`, so providers that do not support a parameter (for example a JSON schema) are excluded instead of ignoring it ([provider routing](https://openrouter.ai/docs/features/provider-routing)).
3. **Data protection.** Send `data_collection: "deny"` and `zdr: true`, and set the same at account level; these restrict routing to providers that do not collect data and to zero-data-retention endpoints ([provider routing](https://openrouter.ai/docs/features/provider-routing)).
4. **Structured output.** Use `response_format: {type: "json_schema", strict: true}` built from Zod schemas, and only choose models whose providers list structured-output support ([structured outputs](https://openrouter.ai/docs/features/structured-outputs)). Always re-validate with Zod; on failure, one repair retry, then mark the item failed.
5. **Prompt caching.** For Anthropic models, mark the long, shared system prompt and rubric with `cache_control`; record `cached_tokens` from usage.
6. **Log what actually served the call.** Store the response's model and provider, token usage and cost on every audit row.

Request shape every call uses, with `temperature` included only when the pinned ZDR endpoint supports it:

```json
{
  "model": "anthropic/claude-sonnet-4.5",
  "temperature": 0,
  "messages": ["..."],
  "response_format": {"type": "json_schema", "json_schema": {"name": "kpi_score", "strict": true, "schema": {}}},
  "provider": {
    "order": ["anthropic"],
    "allow_fallbacks": false,
    "require_parameters": true,
    "data_collection": "deny",
    "zdr": true
  }
}
```

The model slugs above are placeholders; pick current ones in `config/models.ts`.

**Model profile per role (defaults, tunable):**

| Role | Profile "quality" | Profile "cheap" | Why |
| --- | --- | --- | --- |
| Designer | Frontier reasoning model | Same | Few calls, high leverage |
| Relevance pre-screen | Small fast model | Small open-weight model | Thousands of yes/no calls |
| Analyst | Strong mid-tier model | Small model + more Reviewer escalation | Bulk of the cost |
| Reviewer | **Different vendor** from Analyst | Different vendor | Uncorrelated errors |
| Discovery namer / researcher | Frontier model | Mid-tier | Open-ended reasoning |
| Embeddings | Open-source model run locally (default) | Same | Free and reproducible; OpenRouter-hosted embeddings as a fallback option |

**Trade-offs of OpenRouter to accept or revisit:**

- No access to provider batch APIs (roughly half-price overnight jobs). If Analyst cost becomes the bottleneck, add a direct-provider adapter behind the same gateway interface for batch runs only.
- Pricing adds OpenRouter's margin over direct provider prices.
- One more party in the data path; mitigated by ZDR routing and account-level privacy settings.
- Strict JSON schema support differs by model and provider; the model registry check below must run at startup.

**Startup check:** the gateway checks OpenRouter's models, provider endpoints, and ZDR endpoints, then selects a provider with valid token prices and structured-output and tool support. It refuses to start if no eligible provider exists.

## Agents

Four LLM roles, each a typed function with a fixed prompt file, a Zod output schema and a model from config; only the Analyst's evidence step and the discovery researcher run a tool loop.

| Role | Input | Output | Tool loop | Calls per run (3,000 stocks, 5 KPIs) |
| --- | --- | --- | --- | --- |
| Designer | Brief, settings, sample of universe | Sub-themes + KPI framework | No | 2–5 |
| Pre-screen classifier | Stock description + theme | `relevant: yes/no/maybe` + one line | No | \~3,000 (after embedding cut: \~600) |
| Analyst | Stock × KPI + retrieved evidence | `KPIScore` | Yes, max 6 turns | \~1,500 (300 shortlisted × 5) |
| Reviewer | `KPIScore` + the evidence it cites | `accept / retry / escalate` + note | No | \~1,500 + retries |
| Discovery researcher | Candidate cluster | `CandidateTheme` with case for and against | Yes, max 15 turns | 10–30 per weekly job |

### Designer

Turns the brief into a measurable framework. It must:

- Propose 2–5 sub-themes and 3–8 KPIs in total.
- Tag each KPI with a scoring method, preferring `quant` > `extract_then_quant` > `judgement`.
- Write an anchored 0–4 rubric plus `unknown` for every non-quant KPI.
- Name the sources each KPI uses, chosen only from the data providers that are configured.
- Mark at most one KPI as a **gate** (a stock scoring 0 on it cannot enter the basket).
- Suggest default weights summing to 1.

```ts
const KPISpec = z.object({
  id: z.string(),                     // "storage_revenue_share"
  name: z.string(),
  definition: z.string(),
  method: z.enum(["quant", "extract_then_quant", "judgement"]),
  sources: z.array(SourceId),
  rubric: z.record(z.enum(["0","1","2","3","4"]), z.string()).optional(),
  thresholds: z.array(z.number()).optional(),   // for extract_then_quant bucketing
  quantQuery: z.string().optional(),            // id of a registered quant function
  lookbackDays: z.number().int(),
  weight: z.number().min(0).max(1),
  isGate: z.boolean(),
});
```

After gate 1 the framework is frozen as `kpi_framework_versions` row; all scores reference that version.

### Analyst

Scores one stock on one KPI. Flow:

1. `quant` → call the registered quant function on point-in-time data. No LLM.
2. Otherwise retrieve candidate passages for the ticker from the KPI's sources, filtered to `published_at ≤ as_of` and the lookback window.
3. Rerank with embeddings (and optionally a cross-encoder) and keep the top 10.
4. If evidence is thin, the tool loop may call `searchFilings`, `searchNews`, `getSegments`, `getFundamentals`, `fetchIrPage` (all date-filtered) up to 6 turns.
5. Return `KPIScore` via structured output, citing only evidence IDs it was given.
6. Code validates: IDs exist, quotes occur verbatim, values in range. `extract_then_quant` levels are set by code from `thresholds`.

```ts
const KPIScore = z.object({
  ticker: z.string(), kpiId: z.string(), asOf: z.string(),
  extractedValue: z.number().nullable(),
  level: z.enum(["0","1","2","3","4","unknown"]),
  evidenceIds: z.array(z.string()).min(0),
  quotes: z.array(z.string()).max(4),       // short verbatim spans
  rationale: z.string().max(600),
  conflicts: z.array(z.string()),
});
```

System prompt rules (abridged): use only the provided evidence; do not use prior knowledge of the company; cite an evidence ID for every claim; return `unknown` when evidence cannot support a level; list evidence pointing the other way under `conflicts`.

**Confidence** is computed by code, not asked of the model: source quality (filing > transcript/press release > news), recency of newest supporting evidence, number of independent sources, presence of conflicts, validation result, and agreement with a second sample on borderline levels (1–3).

### Reviewer

A different model vendor from the Analyst. Sees the score, the cited passages and the rubric, not the Analyst's hidden reasoning. Returns:

```ts
const Review = z.object({
  verdict: z.enum(["accept", "retry", "escalate"]),
  issue: z.enum(["none","unsupported_level","wrong_entity","stale_evidence","talk_not_numbers","conflict","other"]),
  note: z.string().max(400),
  suggestedLevel: z.enum(["0","1","2","3","4","unknown"]).optional(),
});
```

Policy in code: `retry` sends the note back to the Analyst (max 2); a third failure or any `conflict` on a gate KPI → `escalate`. Sampling: review 100% of pairs with level ≥ 2 or confidence < 0.6, and a random 10% of the rest.

### Discovery researcher

Runs only in the weekly discovery job (see Data layer for detection). For each candidate cluster it gets tools `searchNews`, `searchFilings`, `searchPatents`, `searchPapers`, `countMentions`, `screenUniverse` and must return:

```ts
const CandidateTheme = z.object({
  name: z.string(), thesis: z.string(),
  drivers: z.array(z.string()),
  firstOrder: z.array(z.string()), secondOrder: z.array(z.string()),
  caseFor: z.array(EvidenceClaim), caseAgainst: z.array(EvidenceClaim),
  parentTheme: z.string().nullable(),
  substance: z.enum(["0","1","2","3","4"]),   // rubric: talk only → committed capital with figures
  durability: z.enum(["0","1","2","3","4"]),
});
```

Budget: 15 turns and a dollar cap per candidate; every tool call is logged.

## Data layer

All data enters through one `DataProvider` interface that returns timestamped records; v1 runs on free and open sources, and EODHD is a drop-in provider enabled by an API key.

### Provider interface

```ts
interface DataProvider {
  id: SourceId;                                   // "sec_edgar", "gdelt", "eodhd", ...
  capabilities: Capability[];                     // "securities","prices","fundamentals","segments","filings","news","transcripts","patents","papers","policy"
  sync(opts: SyncOpts): Promise<SyncReport>;      // pull into local store; idempotent
  // Read paths used by agents/tools always go to the LOCAL store, never live:
}

type EvidenceDoc = {
  id: string;                 // stable: `${source}:${nativeId}:${chunk}`
  source: SourceId; securityId: string | null;
  kind: "filing" | "press_release" | "transcript" | "news" | "patent" | "paper" | "policy" | "ir_page";
  publishedAt: string;        // when it became public (point-in-time key)
  ingestedAt: string;         // when we stored it
  url: string; title: string; text: string; sha256: string;
};
```

Agents never call external APIs directly. Providers sync into Postgres and blob storage; tools query the local store with `as_of` filters. That makes runs reproducible and backtests honest.

### Sources by priority

| Need | Open source (v1 default) | EODHD (optional) | Notes |
| --- | --- | --- | --- |
| Security master, IDs | SEC company tickers + CIK, OpenFIGI | Exchange symbol lists, ID mapping | Map everything to an internal `security_id` |
| Prices, market cap, liquidity | Stooq / exchange EOD files (check terms) | EOD prices | Needed for universe filters and ADV |
| Fundamentals | SEC XBRL `companyfacts` and `frames` APIs | Fundamentals endpoint | XBRL is US-only; EODHD adds non-US |
| Revenue by segment | XBRL segment facts + LLM extraction from 10-K text | Fundamentals (partial) | Core input for exposure KPIs |
| Filings text | SEC EDGAR full-text and submissions; Companies House (UK) | — | 10-K/10-Q/8-K/20-F, press-release exhibits |
| Earnings call content | 8-K press releases, company IR pages (scraped) | — | Full transcripts are rarely free; plan a paid source later |
| News | GDELT DOC API, company and trade RSS feeds | News feed with sentiment | GDELT gives breadth for discovery |
| Patents | USPTO PatentsView, EPO OPS | — | Discovery and tech-exposure KPIs |
| Research papers | OpenAlex, arXiv | — | Discovery only |
| Policy | Federal Register API, EU Official Journal, UK legislation feeds | — | Policy-driven themes |
| Screening | Local SQL over the above | Screener endpoint |  |

### EODHD adapter

Built in phase 1 but disabled until `EODHD_API_KEY` is set. EODHD exposes end-of-day prices, fundamentals, screening and ticker-tagged news with sentiment over a REST API authenticated by an `api_token` query parameter ([Jentic EODHD summary](https://jentic.com/apis/eodhd.com/eodhd)). Example endpoints are `/api/fundamentals/{TICKER}`, `/api/news?s={TICKER}` and `/api/sentiments` ([EODHD fundamentals page](https://eodhd.com/lp/fundamental-data-api)). Generate the TypeScript client from EODHD's official OpenAPI 3.1 spec rather than hand-writing it ([EODHD](https://eodhd.com/?via=smr)). The free plan allows only 20 calls a day ([EODHD](https://eodhd.com/?via=tradingblox)), so contract tests use recorded fixtures.

Adapter rules: map EODHD tickers (`AAPL.US`) to `security_id`; store raw JSON in blob storage with fetch timestamp; treat EODHD fundamentals as **not point-in-time** unless the filing date is present, and use the filing date as `publishedAt`.

### Scraping

- Crawlee + Playwright for JavaScript-heavy IR sites; plain `fetch` + Readability for static pages; `unpdf` for PDFs.
- Respect `robots.txt` and site terms; identify with a contact User-Agent (SEC requires one); per-domain rate limits; cache by URL + ETag.
- An allow-list of domains per source; no scraping of paywalled or login-only content.
- Every scraped page stored with its fetch time; a page only becomes evidence for `as_of` dates after its first fetch.

### Point-in-time store

- Every record has `publishedAt` and `ingestedAt`. Agent tools filter on `publishedAt ≤ as_of`; backtests also require `ingestedAt` within a tolerance of `publishedAt` for sources where history is reconstructed.
- Fundamentals are stored as facts with `period_end`, `filed_at`, and `restated` flags; the latest-as-of query picks the last fact filed before `as_of`.
- A **data snapshot** is the set of `(source, max ingestedAt)` at run start; its ID is stored on the run.

### Chunking and embeddings

- Chunk documents by section (Item 1, Item 7, MD&A, segment notes) then \~800 tokens with overlap; keep `section` on each chunk.
- Embed with an open-source model served locally (e.g. via Text Embeddings Inference or Ollama); store in pgvector with an HNSW index. The model name and version are part of the snapshot.
- Hybrid retrieval: Postgres full-text (`tsvector`) + vector similarity, fused by reciprocal rank.

### Discovery detection (no LLM)

Weekly over the last 4–12 weeks of news, filings, patents and papers:

1. Term bursts: n-grams and entities whose weekly count is > 3σ over their 52-week baseline and mentioned by ≥ 5 distinct companies.
2. Embedding clusters (HDBSCAN in the Python sidecar) compared to prior windows: flag new or fast-growing clusters.
3. Cross-source confirmation score: a cluster seen in two or more source kinds ranks higher.
4. Dedupe against the theme taxonomy (embedding distance to existing themes).
5. Top 20–30 clusters go to the discovery researcher.

## Scoring, packaging and audit

The final theme score is a transparent weighted formula in plain TypeScript, so every name's score decomposes exactly into KPI contributions; no LLM runs after gate 2.

### Theme score

```latex
S_i = \mathbb{1}[\text{gate}_i > 0] \cdot \sum_k w_k \cdot \frac{L_{ik}}{4}
```

- L is the KPI level 0–4 for stock i and KPI k; w are the approved weights (sum to 1).
- `unknown` handling is a run setting: **strict** (pure-play) treats it as 0; **lenient** drops that KPI for the stock and renormalises the remaining weights, and caps the stock's score at 0.8 if more than half its KPI weight is unknown.
- Contribution of KPI k to stock i = w\_k × L\_ik / 4. Because the score is linear, these contributions are exact; SHAP is unnecessary in v1.
- Optional v2: a learned ranker (e.g. gradient-boosted trees in the Python sidecar) trained on PM include/exclude decisions, explained with TreeSHAP. Only added if PM labels show the linear score misranks.

### Basket construction

1. Drop stocks failing the gate KPI or excluded at gate 2.
2. Rank by theme score; tie-break by confidence, then liquidity.
3. Take the top N (setting), with optional sector cap (default 30%) and region cap.
4. Weight: equal, score-weighted (w ∝ S), or score × √market cap; apply the per-name cap and redistribute iteratively.
5. Report liquidity: days to trade a notional (setting) at 10% of ADV.

### Explanations per name

- Top 2 KPI contributions with their rationale and 1–2 quotes linked to sources.
- Conflicts and any human override with user, reason and timestamp.
- Factor tilt summary for the basket (size, value/growth via simple fundamentals, sector) so a theme that is secretly a factor bet is visible.

### Audit trail

Append-only tables; nothing is updated in place.

| Table | One row per | Key fields |
| --- | --- | --- |
| `llm_calls` | Model call | run\_id, role, prompt\_version, model, provider served, params, request hash, input evidence IDs, response JSON, tokens, cached tokens, cost, latency |
| `tool_calls` | Agent tool call | llm\_call\_id, tool, args, result IDs |
| `kpi_scores` | Stock × KPI attempt | framework\_version, attempt, score JSON, validation result, confidence |
| `reviews` | Reviewer verdict | score\_id, verdict, issue, note |
| `human_decisions` | Gate action | user, stage, target, action, reason, timestamp |
| `runs` | Theme run | settings, snapshot\_id, framework\_version, model profile, status history |

Export: a single JSON bundle (plus Parquet for scores) that lets anyone rebuild the basket from stored records without calling a model.

### Reproducibility

- Pinned model slug and pinned provider per role. Set `temperature: 0` only where the pinned ZDR endpoint supports it; otherwise omit it. Set `seed` where supported. Omitting temperature does not guarantee temperature-zero reproducibility.
- Prompt files versioned; data snapshot ID on the run; embedding model version recorded.
- LLM response cache keyed on the full request hash. A **replay** mode rebuilds a run from cache only and must match byte for byte.
- Stability is measured, not assumed: the eval suite re-runs pairs with cache off (see Evaluation).

## Tech stack, repo layout and data model

TypeScript end to end with shared Zod types between UI, API and workers; Python appears only in an optional analytics sidecar.

### Stack decisions

| Concern | Choice | Reason / alternative |
| --- | --- | --- |
| Language | TypeScript (strict), Node 22 | One language for UI and backend; shared types |
| Monorepo | Bun workspaces + Turborepo | Simple, fast caching |
| Frontend | Next.js + React + Tailwind + shadcn/ui | Alt: Vite + React if no SSR needed |
| API | Hono | Small, typed, runs anywhere |
| Validation / schemas | Zod (+ `zod-to-json-schema` for LLM schemas) | Single source of truth |
| DB | Postgres 16 + pgvector | One store for state, text search and vectors |
| ORM / migrations | Drizzle | SQL-first, typed |
| Jobs | pg-boss | No Redis needed; alt BullMQ |
| LLM | `openai` SDK → OpenRouter | No LangChain; see Architecture |
| Embeddings | Local open model via TEI or Ollama | Free, reproducible |
| Scraping | Crawlee, Playwright, Readability, unpdf | Open source |
| Analytics sidecar | Python 3.12, FastAPI, scikit-learn, hdbscan, shap, polars | Optional from phase 3 |
| Tests | Vitest, Playwright (e2e), MSW for HTTP fixtures |  |
| Observability | OpenTelemetry, Langfuse self-hosted | Open source |
| Auth | Better Auth (email / GitHub) | Single team |
| Deploy | Docker Compose (dev and single VM) | Later: Fly.io or k8s |

### Repo layout

```text
open-foresight/
  apps/
    web/                 # Next.js UI
    api/                 # Hono API
    worker/              # pg-boss workers: stages + discovery
  packages/
    core/                # domain types (Zod), run state machine, scoring, packaging
    llm/                 # OpenRouter gateway, runAgent loop, cache, limiter, model registry
    prompts/             # versioned .md prompts + rubric templates
    agents/              # designer, analyst, reviewer, prescreen, discovery-researcher
    data/                # DataProvider interface + adapters
      providers/
        sec-edgar/  openfigi/  gdelt/  patentsview/  openalex/  federal-register/
        scraper/  eodhd/     # eodhd disabled without key
    retrieval/           # chunking, embeddings, hybrid search, rerank
    db/                  # Drizzle schema, migrations, queries
    evals/               # labelled sets, metrics, eval runner
  services/
    analytics/           # optional Python sidecar
  config/
    models.ts            # role → model + provider pinning
    sources.ts           # enabled providers, rate limits, allow-lists
  docs/
    SPEC.md  CONTEXT.md  adr/
  docker-compose.yml
```

### Core tables

| Table | Purpose |
| --- | --- |
| `securities` | Internal `security_id`, tickers, CIK, FIGI, ISIN, exchange, sector, country |
| `prices_daily` | Close, volume, market cap by date |
| `fundamental_facts` | Concept, value, period\_end, filed\_at, source |
| `documents` / `chunks` | Evidence docs and chunks with `published_at`, `ingested_at`, tsvector, embedding |
| `snapshots` | Data snapshot definitions |
| `themes` | Theme taxonomy (name, parent, embedding, status) |
| `runs` | Theme runs: settings, status, snapshot, framework version |
| `kpi_framework_versions` | Frozen KPI specs per run |
| `universe_members` | Stocks after hard filters and pre-screen, with reason |
| `kpi_scores`, `reviews` | Analyst and Reviewer outputs per attempt |
| `baskets`, `basket_members` | Final names, scores, weights, contributions |
| `human_decisions` | Gate actions and overrides |
| `llm_calls`, `tool_calls`, `llm_cache` | Audit and cache |
| `discovery_runs`, `candidate_themes` | Weekly discovery output and PM verdicts |
| `eval_sets`, `eval_labels`, `eval_results` | Labelled data and metric history |

### Run status machine

`draft → universe_built → designing → awaiting_kpi_approval → prescreening → analysing → reviewing → awaiting_flag_review → packaging → done`, plus `failed` and `cancelled` from any state. Only API actions move past the two `awaiting_*` states.

## Evaluation, testing and leakage controls

Evals are a first-class package from phase 1: no prompt, model or scoring change merges without the eval suite passing its thresholds.

### Test layers

| Layer | What | How |
| --- | --- | --- |
| Unit | Scoring, basket rules, point-in-time queries, status machine, schema validation | Vitest, no network |
| Contract | Each data provider against recorded responses | MSW fixtures; nightly live check with small quotas |
| LLM gateway | Provider pinning, schema enforcement, retries, cache keys | Mock OpenRouter server; one live smoke test per configured model |
| Agent | Each role on golden inputs | Fixed evidence packs → expected levels / verdicts |
| End to end | A small theme on a 50-stock universe from brief to basket | Playwright through the UI, recorded LLM responses (replay) |

### Labelled sets

- **KPI set:** 200 stock × KPI pairs across 3 themes, labelled by an analyst with level and evidence. Target weighted kappa ≥ 0.6.
- **Relevance set:** 500 stocks labelled relevant / not for 3 themes. Target pre-screen recall ≥ 0.95 (missing a name is worse than an extra call).
- **Reviewer set:** 100 deliberately flawed scores (wrong company, stale evidence, talk without numbers). Target catch rate ≥ 0.8.
- **Reference baskets:** holdings of 3–5 public thematic ETFs or indices, intersected with the universe, for recall checks.

### Metrics tracked per eval run

- Weighted kappa and exact-level agreement vs analyst labels.
- Run-to-run stability (cache off, same snapshot).
- Citation validity and verbatim-quote rate.
- `unknown` rate per KPI (too high → KPI not measurable with current data).
- Pre-screen recall / precision; Reviewer catch rate and false-alarm rate.
- Basket recall vs reference, overlap and turnover between runs.
- Cost, tokens, cached-token share and wall time per stage.

### Leakage controls (backtests)

LLMs know what happened after the as-of date from training. Controls:

1. Tools only return records with `publishedAt ≤ as_of`; enforced in SQL, tested in unit tests.
2. The Analyst prompt forbids prior knowledge; a **leakage probe** checks rationales for facts not present in cited evidence (entity and number matching) and fails the pair if found.
3. **Name-masking test:** re-run a sample with company names and tickers replaced by placeholders; large level changes signal reliance on memory.
4. For historical backtests, prefer models whose training cutoff precedes the backtest window, and record cutoffs in `config/models.ts`.
5. Discovery backtests keep detection purely statistical and use the LLM only to name clusters; judge success by lead time vs public thematic product launches.

### Release gates

A change to prompts, models, scoring or retrieval must report the metrics above against the last accepted baseline. Merge blocked if kappa drops > 0.05, citation validity < 100%, or cost per run rises > 25% without sign-off.

## Roadmap

Six phases over roughly 15 weeks (estimate, one engineer with coding agents); a usable basket exists after phase 1, and each phase ends at a measurable gate.

&#91;embedded content: roadmap · 6 phases, each ending at a gate\]

The highlighted phase is the first point where a PM can use the product on a real theme.

### Phase scope and acceptance criteria

1. **Phase 0 — Foundations.** Monorepo, Docker Compose (Postgres + pgvector, MinIO, Langfuse), Drizzle schema for runs and audit, OpenRouter gateway with provider pinning, model registry startup check, `runAgent` loop, cache, limiter, CI, eval runner skeleton.
   - A structured-output call to two configured models succeeds with `allow_fallbacks: false` and is logged in `llm_calls`.
   - Cache hit returns identical output without a network call.
2. **Phase 1 — First theme end to end (US only).** Providers: SEC tickers/CIK, OpenFIGI, XBRL facts, EDGAR filings, EOD prices. Chunking, local embeddings, hybrid search. Designer, Analyst (no tool loop), packaging, UI for brief, gate 1 and basket.
   - A 50-stock theme runs from brief to basket in under 30 minutes.
   - 100% of cited evidence IDs exist; quotes found verbatim ≥ 98%.
   - Point-in-time filter has unit tests proving no future document is returned.
3. **Phase 2 — Review, audit, full scale.** Reviewer (different vendor), retry policy, gate 2 queue UI, overrides, audit bundle export, replay mode, pre-screen (embeddings + classifier), full \~3,000-stock universe, KPI labelled set.
   - Weighted kappa ≥ 0.6 on the 200-pair set; stability ≥ 95%.
   - Reviewer catches ≥ 80% of the flawed-score set.
   - Full-universe run under the agreed cost budget and 4 hours.
4. **Phase 3 — More data and the tool loop.** GDELT news, IR and press-release scraping, Companies House, EODHD adapter switched on (fundamentals, news, non-US prices), Analyst tool loop, run diff.
   - `unknown` rate on judgement KPIs falls versus phase 2 on the pilot themes.
   - EODHD contract tests pass on recorded fixtures; disabling the key changes nothing else.
5. **Phase 4 — Discovery.** Patents, papers and policy providers; burst detection; Python sidecar for clustering; discovery researcher; theme taxonomy; discovery inbox with accept / reject and reasons.
   - Weekly job publishes 5–10 deduplicated candidates with case for and against.
   - Historical replay flags at least some known themes before public thematic products launched.
6. **Phase 5 — Hardening.** Backtest mode over past as-of dates, leakage probe and name-masking tests, factor tilt report, HTML/PDF run report, deployment to a VM, backups.
   - Replay rebuilds a past run byte for byte from stored records.
   - A PM runs a live theme without engineer help.

## Risks, open questions and handoff

The biggest risks are data coverage outside the US and the quality of the LLM's KPI judgements; both are measured early by the phase 1–2 evals rather than assumed.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Free data is US-heavy (XBRL, EDGAR) | Weak non-US coverage | Enable EODHD fundamentals and news; Companies House for UK filings |
| No free earnings call transcripts | Forward-commitment KPIs rely on press releases and IR pages | Measure `unknown` rate; budget a paid transcript source if it stays high |
| LLM judgement errors on judgement KPIs | Wrong names in basket | Prefer quant KPIs; Reviewer on a different vendor; human gate 2; kappa gate |
| Training-data leakage in backtests | Overstated historical results | Point-in-time tools, leakage probe, name-masking test |
| OpenRouter routing changes or provider outages | Non-reproducible runs, failed jobs | Provider pinning with fallbacks off; startup model check; replay cache |
| Cost of Analyst calls at scale | Expensive runs | Embedding + classifier pre-screen; cache; small-model profile; optional direct batch adapter |
| Scraping breaks or violates terms | Missing evidence, legal exposure | Allow-lists, robots.txt, per-source contract tests, prefer APIs |
| Theme is secretly a factor or sector bet | Misleading product | Factor tilt report on every basket |

### Open questions

- [ ] Universe for v1: US only, or US + Europe (decides whether EODHD is needed in phase 1)?
- [ ] Which 3 pilot themes and which public thematic ETFs serve as reference baskets?
- [ ] Who labels the 200 KPI pairs, and how much analyst time is available?
- [ ] Budget per theme run and monthly OpenRouter cap?
- [ ] Is a paid transcript source acceptable later?
- [ ] Hosting: local machine, a single VM, or company cloud? Any data-residency rules?
- [ ] Does gate 2 need two-person sign-off for compliance?

### How to hand this to Claude Code or Codex

1. Export this doc as Markdown and save it in the new repo as `docs/SPEC.md`.
2. With Matt Pocock's skills, the intended order is shape, specify, decompose, build, review ([AI Hero skills](https://www.aihero.dev/skills)): run `/setup-matt-pocock-skills`, then `/grill-with-docs` on `docs/SPEC.md` to settle the open questions above, `/to-spec` to produce the final spec, `/to-tickets` to cut it into tickets, `/implement` per ticket (test-first), and `/code-review` against the spec.
3. Use `/domain-modeling` early so terms like *run*, *gate*, *KPI framework version*, *evidence*, *snapshot* and *as-of* are written to `docs/CONTEXT.md` and used consistently.
4. For a pstack-style flow, feed the same `docs/SPEC.md` as the PRD. I could not open the pstack repository page to check its exact commands, so map the phases in the roadmap to its planning steps manually.
5. Build phase by phase. Each roadmap phase is sized to become one epic of 8–15 tickets.

Kickoff prompt to paste:

```text
Read docs/SPEC.md. We are building Open Foresight in TypeScript (Bun + Turborepo).
Constraints: no LangChain or LangGraph; all LLM calls via the openai SDK pointed at OpenRouter
with pinned provider, allow_fallbacks=false, require_parameters=true, zdr=true;
open data first; EODHD adapter behind DataProvider, disabled without EODHD_API_KEY.
Start with Phase 0 and Phase 1 only. First grill me on the open questions, then write
docs/CONTEXT.md and ADRs for the stack decisions, then produce tickets with acceptance criteria.
Every ticket must include tests. Do not call live paid APIs in tests; use recorded fixtures.
```

### Sources

- [OpenRouter API overview](https://openrouter.ai/docs/api/reference/overview.md)
- [OpenRouter provider routing](https://openrouter.ai/docs/features/provider-routing)
- [OpenRouter structured outputs](https://openrouter.ai/docs/features/structured-outputs)
- [EODHD API summary (Jentic)](https://jentic.com/apis/eodhd.com/eodhd)
- [EODHD fundamentals and news API](https://eodhd.com/lp/fundamental-data-api)
- [EODHD developer resources](https://eodhd.com/?via=smr)
- [AI Hero skills by Matt Pocock](https://www.aihero.dev/skills)
- [Axyon Foresight](https://axyon.ai/solutions-axyon-foresight) (design reference)
