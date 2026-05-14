# Polyvise Architecture

Polyvise starts as a text-first decision-support app. A user submits a free-text subject, the system reframes it as a neutral resolution, and a Hybrid Council produces a cited debate plus a synthesis.

## Runtime

- Next.js App Router serves the UI and API endpoints.
- API routes expose debate creation, debate retrieval, run events, and follow-up questions.
- The local repository uses an in-memory store so development works without external services.
- The production data model is defined with Drizzle for Supabase Postgres.

## Debate Pipeline

1. Frame the subject into a neutral resolution.
2. Classify topic kind as policy, value, empirical, decision, or comparison.
3. Run five stance scouts to discover plausible perspectives.
4. Select two pro agents, two con agents, and one neutral judge.
5. Collect cited evidence through Brave Search when configured, falling back to deterministic development references.
6. Generate opening, cross-examination, rebuttal, closing, judge review, and synthesis turns.
7. Persist claims, sources, scorecard, trace entries, and summary.

## Provider Boundaries

- `src/lib/providers/llm.ts` defines the model roster and structured LLM provider boundary.
- `src/lib/providers/search.ts` defines Brave Search and mock evidence providers.
- `src/lib/workflows/debate-workflow.ts` defines durable workflow steps for an Inngest production implementation.

## Product Defaults

- V1 optimizes for Decision Support.
- Default mode is Hybrid Council.
- Default evidence mode is cited.
- Debate Showcase and Model Lab are retained as future modes in the app notes panel.
