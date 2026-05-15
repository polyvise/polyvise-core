# Polyvise Architecture

Polyvise starts as a shared agent debate engine with two branded web surfaces. A user submits a free-text subject, the engine reframes it as a neutral resolution, and a Hybrid Council produces a cited debate plus a synthesis.

The current architecture borrows the useful pattern from TradingAgents-style systems without copying trading-specific behavior: keep the agent graph isolated, run it through a non-interactive manager/executor, emit stable artifacts, and make each step observable enough to persist, retry, and review.

## Runtime

- `apps/polyvise-web` serves the professional `polyvise.com` demo/modeling interface.
- `apps/debatefrog-web` serves the playful `debatefrog.com` public interface.
- `packages/debate-engine` owns the shared agent workflow, schemas, providers, and repository contracts.
- Next.js App Router serves each app's UI and API endpoints.
- API routes expose debate creation, debate retrieval, run events, and follow-up questions where the app needs them.
- `packages/debate-engine/src/debate/repository.ts` defines the debate repository boundary. The default implementation remains in-memory so development works without external services.
- The production data model is defined with Drizzle for Supabase Postgres.
- Runtime model and evidence choices are loaded from `POLYVISE_*` environment variables in `packages/debate-engine/src/debate/config.ts`.

## Architecture Choices

- The debate engine is now a step executor rather than one opaque inline function. This keeps the public API simple while creating a path to durable execution.
- LLM-facing outputs are validated with Zod schemas before they enter the run state. Deterministic mock outputs remain the fallback so local tests are stable.
- Live LLM calls use the OpenRouter adapter when `POLYVISE_ENABLE_MOCK_LLM=false`; validation failures or provider errors fall back to deterministic structured drafts.
- Model selection is runtime-driven. Code should refer to quick, deep, and judge model roles instead of hardcoding provider-specific model names in debate logic.
- The repository boundary is explicit even though the default repository is still in-memory. Future Postgres persistence should implement this boundary rather than changing API routes.
- Evidence remains a provider boundary. Brave Search is the live provider; mock evidence keeps development and tests deterministic.
- API tokens and database credentials belong in local `*.secrets.env` files or deployment secret stores. Tracked env examples must stay placeholder-only.
- Daily local batch output should publish immutable artifacts plus a current manifest pointer. The cloud app should read cloud-hosted data, not call back to a local machine.

## Debate Pipeline

1. Frame the subject into a neutral resolution.
2. Classify topic kind as policy, value, empirical, decision, or comparison.
3. Run five stance scouts to discover plausible perspectives.
4. Select two pro agents, two con agents, and one neutral judge.
5. Collect cited evidence through Brave Search when configured, falling back to deterministic development references.
6. Generate structured claims.
7. Generate opening, cross-examination, and rebuttal turns, bounded by `POLYVISE_MAX_ROUNDS`.
8. Generate the judge scorecard and final summary.
9. Emit an artifact manifest for repository persistence.

Today this pipeline runs inline through `runHybridCouncilDebate`. The step list is intentionally aligned with `packages/debate-engine/src/workflows/debate-workflow.ts` so the same shape can move into Inngest or another durable runner later.

## Provider Boundaries

- `packages/debate-engine/src/providers/llm.ts` defines the structured LLM provider boundary.
- `packages/debate-engine/src/debate/schema.ts` defines Zod schemas for scout, claim, turn, judge, summary, and follow-up outputs.
- `packages/debate-engine/src/providers/search.ts` defines Brave Search and mock evidence providers.
- `packages/debate-engine/src/workflows/debate-workflow.ts` defines durable workflow steps for an Inngest production implementation.
- `packages/debate-engine/src/debate/engine.ts` runs those steps inline today and records trace entries for each step.

## Persistence Direction

The schema already has tables for debates, runs, agents, sources, claims, turns, scorecards, summaries, and model snapshots. The next persistence pass should:

1. Implement a Drizzle-backed `DebateRepository`.
2. Save the debate record before execution and save the run state after each completed step.
3. Persist step trace entries and generated artifacts in append-friendly form.
4. Rehydrate `DebateRecord.latestRun` from normalized tables for the existing API shape.
5. Add resume semantics that skip successful steps and continue from the first missing or failed step.

## Publishing Direction

Local batch processing can produce expensive analysis and upload it daily for the app to consume. The publish manifest contract lives in `packages/debate-engine/src/publishing/manifest.ts`.

Preferred artifact shape:

```text
daily/YYYY-MM-DD/manifest.json
daily/YYYY-MM-DD/full-state.json
daily/YYYY-MM-DD/summary.json
daily/YYYY-MM-DD/report.md
current/manifest.json
```

Only update `current/manifest.json` after the dated artifact bundle validates and uploads successfully.

## Product Defaults

- V1 optimizes for Decision Support.
- Default mode is Hybrid Council.
- Default evidence mode is cited.
- Debate Showcase and Model Lab are retained as future modes in the app notes panel.

## Open Work

- Replace the mock-only LLM provider with real provider adapters that implement `generateStructured`.
- Add targeted evidence requests from scouts or evidence agents instead of one broad search call.
- Add retries around individual workflow steps, with retry metadata in the trace.
- Add eval fixtures for topic classes, citation quality, balance, and judge consistency.
- Add a non-interactive CLI runner that writes a full-state JSON artifact, report, and manifest for smoke tests.
