# Future Direction

This note is for future project threads. The main architectural goal is to turn Polyvise from a deterministic debate renderer into a resumable, structured multi-agent workflow while preserving the existing product model.

## Current State

- The public API still creates a debate synchronously and returns the completed record.
- `src/lib/debate/engine.ts` now runs a named step sequence with trace entries and model snapshots.
- `src/lib/debate/schema.ts` validates structured outputs for scouts, claims, debate turns, judge scorecards, summaries, and follow-ups.
- `src/lib/debate/config.ts` loads model roles and evidence settings from `POLYVISE_*` environment variables.
- `src/lib/debate/repository.ts` defines the storage boundary. The default implementation is still in-memory.
- `.env.example` is non-secret config only. API keys and database credentials belong in ignored `*.secrets.env` files.
- `src/lib/publishing/manifest.ts` defines the daily publish manifest for local batch output and cloud upload handoff.

## Intended End State

Polyvise should have an isolated debate graph managed by a durable runner:

`frame -> scout -> team_builder -> evidence -> opening -> cross_exam -> rebuttal -> judge -> persist`

Each step should be independently observable, retryable, and persisted. Failed runs should resume from the last successful step rather than starting over.

## Next Implementation Order

1. Add a Drizzle-backed repository that implements the existing `DebateRepository` interface.
2. Persist step completion and partial outputs after every workflow step.
3. Add resume support to the inline executor before moving execution to Inngest.
4. Implement real LLM provider adapters behind `LlmProvider.generateStructured`.
5. Let scouts or evidence agents request targeted searches, then normalize and cite those results.
6. Add a CLI smoke runner that can run a debate without the web app and write a full-state artifact manifest.
7. Build eval fixtures for topic class coverage, citation quality, pro/con balance, and judge consistency.

## Deployment Bias

The app should be treated as a stateless reader of cloud-hosted data. Local machines can do expensive daily batch processing, but they should publish immutable artifacts to cloud storage and then atomically update a current manifest pointer.

Initial production bias:

1. Google Cloud Run for the full Next.js app and lowest runtime surprise.
2. Cloudflare Workers/R2 as a proof of concept if the app becomes mostly read-heavy and artifact-driven.
3. Hostinger for simple demos or dashboard-managed hosting, not as the primary workflow control plane.

## Guardrails

- Keep deterministic mocks as the default test path.
- Do not let provider-specific model names leak into debate logic; use quick, deep, and judge roles.
- Keep tracked env examples placeholder-only.
- Prefer adding durable behavior at the executor and repository boundaries instead of rewriting API routes.
- Treat evidence as agent context, not just decorative citations.
- Do not make the cloud app depend on reaching a local machine; publish data outward instead.
