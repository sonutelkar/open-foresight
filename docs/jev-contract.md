# Jev 1.14 contract

Verified against the [TypeSafe System One reference](https://docs.typesafe.ai/api/system-one.md), [quickstart](https://docs.typesafe.ai/introduction/quickstart.md), and [OpenRouter Decisions reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md). On 2026-11-18 three synthetic requests to OpenRouter's `POST /api/alpha/decisions` succeeded with provider `typesafe`, fallbacks disabled, ZDR, and data collection denied. Recorded request and response bodies are in `packages/llm/fixtures/jev/`; authorization headers were never recorded. These observations are not evidence about the System One route.

## Request and response

The JSON request contains `model`, `state`, and `questions`. Questions are keyed by caller-selected names and contain `type`, `instructions`, and optional type-dependent `criteria`. Noul uses instructions alone. Choice uses a map of option keys to descriptions. Score accepts an ordered array of level descriptions. Box and multimodal input are outside this adapter's scope. The response has `id`, served `model`, `provider`, `answers` keyed by question name, and `usage` with token counts and cost. Noul returns `noul` in [0,1]. Choice returns `choice`, `probabilities`, and `confidence`. Score returns a weighted `score`, `legend`, `probabilities`, and `confidence`. In the recorded calls the served model was `typesafe/jev-1.14-20261014` and provider was `TypeSafe`.

A synthetic unsupported question returned HTTP 400 with an `error` object containing `code: 400` and a discriminator validation message. Other errors and rate limits have not been observed in this session. The API reference documents 400, 401, 403, 429, and upstream 5xx errors. Retry policy must not mistake invalid requests or invalid model output for transient failures.

## Privacy and routing

The documented SDK-compatible System One surface is `POST /api/v1/systemone`, but its documented request shape does not establish per-request provider pinning, `zdr`, or `data_collection` controls. The alpha Decisions surface explicitly documents provider preferences and was used for the synthetic live checks. A 200 response with required flags and the ZDR catalog listing provide evidence of availability, not independent verification of provider retention. Verify current account privacy and residency settings before real data. [OpenRouter's model page](https://openrouter.ai/typesafe/jev-1.14) reports EU in-region routing unavailable.

The advertised context is 262,144 tokens. The suggested 32,000-byte long-context threshold and its claimed accuracy impact were not confirmed by the references inspected. The adapter flags input above that size as a provisional warning. A byte count is not a token count or a guarantee of quality. Test accuracy on project data. Speed and calibration claims remain unverified.

The adapter later completed two additional synthetic requests, one Noul and one Choice, and stored both successful records in `llm_calls`. Jev requests are deliberately not cached under the current project decision.
