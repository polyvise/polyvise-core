# Polyvise

Polyvise is a shared agent debate engine plus branded web apps that use it. A user enters a free-text subject, the engine frames it as a neutral resolution, runs a cited Hybrid Council debate, and returns a decision brief with pros, cons, an argument map, transcript, source ledger, and follow-up Q&A.

## Workspace Layout

```text
apps/
  polyvise-web/        # polyvise.com: professional demo/modeling UI
  debatefrog-web/      # debatefrog.com: playful public UI
packages/
  debate-engine/       # shared agent workflow, schemas, providers, storage contracts
docs/
  architecture.md
  deployment.md
  future-direction.md
  monorepo.md
```

`polyvise.com` and `debatefrog.com` are separate products with different personalities. Both call the same `@polyvise/debate-engine` package.

## Current V1

- npm workspaces monorepo with two Next.js App Router apps and one shared engine package.
- Hybrid Council workflow: five stance scouts, two pro debaters, two con debaters, and a neutral synthesis judge.
- Cited by default through a Brave Search provider interface with deterministic local fallback sources.
- Supabase/Postgres schema via Drizzle migrations.
- In-memory development store so the apps run before production persistence is connected.
- Product notes for future Debate Showcase and Model Lab modes.

## Run Locally

```bash
npm install
npm run dev:polyvise
```

Open `http://localhost:3000` for the professional Polyvise interface.

For Debatefrog:

```bash
npm run dev:debatefrog
```

Open `http://localhost:3001`.

To run an app with its local secret file loaded:

```bash
./scripts/dev-polyvise.sh
./scripts/dev-debatefrog.sh
```

## Environment

Copy `.env.example` to `.env.local` for non-secret local configuration.

```bash
NEXT_PUBLIC_SITE_URL="http://localhost:3000"
POLYVISE_QUICK_MODEL="gpt-4.1"
POLYVISE_DEEP_MODEL="claude-3.7-sonnet"
POLYVISE_JUDGE_MODEL="gemini-2.5-pro"
POLYVISE_MAX_ROUNDS="3"
POLYVISE_LLM_TIMEOUT_MS="45000"
POLYVISE_LLM_MAX_TOKENS="1400"
POLYVISE_EVIDENCE_PROVIDER="brave"
POLYVISE_ENABLE_MOCK_LLM="true"
```

Copy `.secrets.env.example` to a local file ending in `.secrets.env`, such as `local.secrets.env`, for API tokens and other secrets. Files matching `*.secrets.env` are ignored by git.

```bash
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres"
BRAVE_SEARCH_API_KEY=""
OPENAI_API_KEY=""
ANTHROPIC_API_KEY=""
GOOGLE_GENERATIVE_AI_API_KEY=""
OPENROUTER_API_KEY=""
```

Load secrets into your shell before starting the app, or configure the same keys in your deployment provider.

For app-specific OpenRouter tokens, use:

```text
apps/polyvise-web/local.secrets.env
apps/debatefrog-web/local.secrets.env
```

The launcher scripts above load the matching file automatically. The secret files do not need execute permissions; only the scripts do.

To verify that an app sees its local secrets without printing token values:

```bash
./scripts/check-env.sh polyvise
./scripts/check-env.sh debatefrog
```

The launcher scripts default to live OpenRouter mode by setting `POLYVISE_ENABLE_MOCK_LLM=false` when it is not already set. To force deterministic local mocks, set `POLYVISE_ENABLE_MOCK_LLM=true` in `.env.local` or the app-specific secret file.

The app works without provider keys by using deterministic mock providers.

## API

- `POST /api/debates`
- `GET /api/debates/:id`
- `GET /api/debates/:id/events`
- `POST /api/debates/:id/followups`

## Verification

```bash
npm run typecheck
npm test
npm run build
```

## Project Notes

- [Architecture](docs/architecture.md) explains the current executor, provider, repository, and persistence choices.
- [Future Direction](docs/future-direction.md) captures the intended durable multi-agent workflow and next implementation order.
- [Deployment Direction](docs/deployment.md) compares Google Cloud, Cloudflare, and Hostinger, and describes the local batch publishing model.
- [Monorepo Notes](docs/monorepo.md) explains the package/app boundaries and why both branded sites live here for now.
