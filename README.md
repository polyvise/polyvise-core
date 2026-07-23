# Polyvise

Polyvise is a framework-neutral TypeScript library for structured, cited, multi-agent debates. It turns a free-text subject into a neutral resolution, assembles opposing agents and a neutral judge, runs a traceable debate workflow, and returns a decision brief with claims, sources, transcript, scorecard, and summary.

This repository contains the core library only. Product websites, persistence, API routes, deployment configuration, and brand-specific behavior live in separate repositories:

- [`polyvise/polyvise-ai`](https://github.com/polyvise/polyvise-ai) — `polyvise.ai`
- [`polyvise/debatefrog`](https://github.com/polyvise/debatefrog) — `debatefrog.com` and the primary reference implementation

## Install

```bash
npm install @polyvise/debate-engine
```

## Example

```ts
import { runHybridCouncilDebate } from "@polyvise/debate-engine";

const run = await runHybridCouncilDebate("example-run", {
  subject: "Should schools have longer recess?"
});
```

The deterministic providers are the development default. Applications can pass runtime configuration and provider implementations through `DebateExecutionOptions`.

## Library Boundary

Polyvise owns:

- debate framing, topic classification, and safety notices
- structured debate types and validation schemas
- the Hybrid Council workflow executor
- LLM and evidence provider contracts and adapters
- model snapshots, traces, and artifact manifest contracts

Applications own:

- HTTP routes, streaming transports, and process-level event buses
- persistence implementations and database migrations
- user feedback and authentication
- environment and secret management
- UI, brand copy, deployment, and operations

## Development

```bash
npm ci
npm run verify
```

`npm run verify` runs typechecking, tests, and the distributable package build.

## Repository History

Polyvise began as a monorepo containing the core library and its first two applications. The final pre-split state is preserved by the `monolith-final-2026-07-23` tag.
