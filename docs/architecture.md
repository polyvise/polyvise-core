# Core Architecture

Polyvise is an application-independent workflow library.

## Execution

The Hybrid Council pipeline is:

```text
frame -> scout -> team_builder -> evidence -> opening
      -> cross_exam -> rebuttal -> judge -> persist artifact
```

`src/debate/engine.ts` runs the steps and emits typed live events. Applications may provide:

- a `DebateRuntimeConfig`
- an `LlmProvider`
- an event callback

The resulting `DebateRun` is a portable value that an application can persist, stream, publish, or render.

## Boundaries

- `src/debate` contains framing, schemas, types, configuration, and execution.
- `src/providers` contains LLM and evidence contracts plus supported adapters.
- `src/workflows` describes the durable workflow boundary.
- `src/publishing` defines portable artifact manifests.

The library does not own application repositories, database clients, HTTP handlers, feedback collection, or deployment configuration. Those concerns belong to each consuming application.

## Reference Implementation

Debatefrog is the primary reference implementation. It demonstrates how to connect the library to Next.js, event streaming, cloud persistence, model providers, and a user-facing product without making those choices part of the core.
