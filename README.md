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

## Optional Environment

Copy `.env.example` to `.env.local` and fill in any live provider keys.

```bash
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres"
BRAVE_SEARCH_API_KEY=""
OPENAI_API_KEY=""
ANTHROPIC_API_KEY=""
GOOGLE_GENERATIVE_AI_API_KEY=""
OPENROUTER_API_KEY=""
```

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
