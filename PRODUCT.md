# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

During the pilot the one person in front of these screens is the builder, acting as analyst and approver. They write a theme brief, edit and approve the KPI framework, then check the provisional basket and the evidence behind each name. The work is done locally on a laptop, in a browser, with the API and worker running on the same machine.

The spec also names a portfolio manager who writes briefs and finalises baskets, and a later compliance reader who exports the audit trail. Those are not confirmed users of the web screens yet.

## Product Purpose

Open Foresight turns an investment theme into an auditable stock basket. A Designer drafts a KPI framework from the brief, a person approves it at gate 1, and code then scores each stock against the approved rubric from stored filings and builds a weighted basket. The score measures thematic exposure, not expected return.

Success means a person can open a basket, pick any name, and trace each KPI level to a verbatim quote in a dated filing, then decide whether to trust it.

## Positioning

Every score traces to a quote. A KPI level is shown with the cited passage, its filing and date, and a link to the source, and the UI flags a quote that is not found word for word in the stored text. A neighbouring thematic-investing tool that shows only a score and a ranking could not truthfully claim this.

## Operating Context

- A run moves through brief, universe, Designer, KPI approval (gate 1), scoring, and a provisional basket. The worker does the long stages. The page polls while it waits.
- The approver enters an analyst name and a local approver token in the top bar. Viewing needs neither.
- Evidence comes from SEC filings, ESEF reports and company reports fetched from the web. Each document has a date that decides which as-of dates it can support.
- The basket stays labelled provisional, because phase 1 has no Reviewer and no final approval gate.
- Two optional Jev checks can lower a level or settle a gate. The UI shows a lowered level with its reason.

## Capabilities and Constraints

- Brief entry with validation, an editable KPI rubric with weights, and authenticated approval that freezes a framework version and records the decision.
- A run page with progress, the funnel from universe to selection, the ranked basket with scores, confidence and weights, and per-name KPI evidence with source links.
- Agents read only the local Postgres store and never call external sources during a run.
- Out of scope for the product: trading, order generation, return forecasting, multi-user accounts and billing.
- Terms in use: theme, brief, KPI framework, rubric level 0 to 4 or unknown, gate, provisional basket, funnel, evidence, as-of date.
- Undecided: whether a portfolio manager gets their own read-only view, and the final basket approval screen.

## Brand Commitments

The name is Open Foresight. No logo, wordmark or voice guide exists beyond the plain, direct wording already in the interface.

## Evidence on Hand

- `docs/SPEC.md` and `docs/PHASE-0-1-PLAN.md` for scope, users and the phase plan.
- `docs/screenshots/` holds screens from the pilot runs. The PR 15 run produced a real 14-name provisional basket from real SEC and ESEF filings.
- No customer quotes, testimonials, benchmarks or pricing exist. Do not invent any.

## Product Principles

1. Show the source before the claim. A score is never displayed without a way to reach its quote.
2. Say what is not known. Unknown, lowered and provisional states are shown plainly and never hidden to look cleaner.
3. A person decides at the gates. The interface presents evidence and records the decision, and does not decide for them.
4. Code owns the numbers. The interface shows computed scores and weights as they are and never rounds a story around them.

## Accessibility & Inclusion

Used on a laptop at a desk. Everything must be keyboard operable, text must have readable contrast, and both light and dark themes must work. Phone use should work but is not optimised for.
