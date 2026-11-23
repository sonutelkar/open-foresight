# Rules
- Spec: docs/SPEC.md. Glossary: docs/CONTEXT.md.
- TypeScript strict, Bun + Turborepo. No LangChain/LangGraph.
- All LLM calls go through packages/llm (openai SDK → OpenRouter, pinned provider,
  allow_fallbacks=false, require_parameters=true, zdr=true).
- Exception, Reviewer only (operator decision 2026-11-23): the `reviewer` route (`zdr: 'warn'`) is unpinned and does not require ZDR; the gateway warns when no ZDR endpoint exists and records the served provider.
- Agents read only the local Postgres store; never call external APIs from agent tools.
- EODHD adapter must stay optional (disabled without EODHD_API_KEY).
- Tests use recorded fixtures; never hit paid APIs in tests.
- Work one ticket at a time; run tests before finishing.
