# Monorepo Notes

Polyvise is now organized as a monorepo because the engine and the branded experiences are still evolving together. This keeps product iteration fast while making the architectural boundaries visible.

## Packages And Apps

```text
apps/polyvise-web
apps/debatefrog-web
packages/debate-engine
```

`packages/debate-engine` owns agent activity:

- debate workflow executor
- structured output schemas
- LLM provider interface
- evidence provider interface
- repository and persistence contracts
- publishing manifest contracts
- shared debate types

`apps/polyvise-web` owns the professional demo surface for `polyvise.com`:

- calm decision-support UI
- model-lab and portfolio-friendly presentation direction
- richer transcript, source ledger, and argument map views

`apps/debatefrog-web` owns the playful public surface for `debatefrog.com`:

- friendlier brand voice
- simpler first-run debate flow
- public product experimentation

Both apps import `@polyvise/debate-engine`. App code should not reach into another app.

## Runtime Split

Runtime 1 is the priority:

- cloud-hosted interactive debate requests
- user-facing run, presentation, and finalization
- hard cost limits before broad public use
- powered by `@polyvise/debate-engine`

Runtime 2 is later:

- local/backend-machine batch analysis
- daily rollups, summaries, stats, and static JSON artifacts
- push-only upload to production storage
- app consumes cloud-hosted data and never calls back to a local machine

## Why Not Separate Repos Yet

Separate repos may make sense later if the engine becomes a standalone SDK or if Debatefrog needs an independent release cadence. For now, a monorepo is better because:

- engine changes can be tested against both apps in one commit
- docs and architecture are easier to present as a portfolio system
- shared package boundaries are still settling
- local development stays simple

The current repo still presents clean separation: the engine is a package, each domain has its own app, and each app can deploy independently.

## Commands

```bash
npm run dev:polyvise
npm run dev:debatefrog
npm run build:polyvise
npm run build:debatefrog
npm run typecheck
npm test
```

## Boundary Rules

- Engine package code must stay framework-neutral unless a file is explicitly an adapter.
- Next.js route handlers live in apps, not in the engine package.
- Brand copy, visual style, and UI state live in apps.
- Shared Zod schemas and TypeScript types live in `packages/debate-engine`.
- Deployment secrets stay outside git in ignored `*.secrets.env` files or provider secret stores.
