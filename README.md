# Polyvise

Polyvise is a decision-support web app for AI-agent debates. A user enters a free-text subject, Polyvise frames it as a neutral resolution, runs a cited Hybrid Council debate, and returns a decision brief with pros, cons, an argument map, transcript, source ledger, and follow-up Q&A.

## Current V1

- Next.js App Router, TypeScript, Tailwind, lucide icons, and React Flow.
- Hybrid Council workflow: five stance scouts, two pro debaters, two con debaters, and a neutral synthesis judge.
- Cited by default through a Brave Search provider interface with deterministic local fallback sources.
- Supabase/Postgres schema via Drizzle migrations.
- In-memory development store so the app runs before production persistence is connected.
- Product notes for future Debate Showcase and Model Lab modes.

## Run Locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment

Copy `.env.example` to `.env.local` for non-secret local configuration.

```bash
NEXT_PUBLIC_SITE_URL="http://localhost:3000"
POLYVISE_QUICK_MODEL="gpt-4.1"
POLYVISE_DEEP_MODEL="claude-3.7-sonnet"
POLYVISE_JUDGE_MODEL="gemini-2.5-pro"
POLYVISE_MAX_ROUNDS="3"
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
```

## Project Notes

- [Architecture](docs/architecture.md) explains the current executor, provider, repository, and persistence choices.
- [Future Direction](docs/future-direction.md) captures the intended durable multi-agent workflow and next implementation order.
- [Deployment Direction](docs/deployment.md) compares Google Cloud, Cloudflare, and Hostinger, and describes the local batch publishing model.
