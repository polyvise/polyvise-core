# Deployment Direction

Polyvise should be deployable as a stateless presentation app backed by cloud-hosted data. The likely production shape is:

`local batch producer -> cloud object store / database -> stateless Next.js app`

The cloud app should not depend on reaching a local machine. Local jobs should publish validated daily artifacts to the cloud, then the app should read the newest complete manifest.

## Recommended Path

Start with Google Cloud Run for the first serious deployment. It runs a normal Node.js/Next.js service, keeps Docker available as an escape hatch, and fits future Postgres persistence and background workflow needs cleanly.

Use Cloudflare as a parallel proof of concept if edge hosting and R2 are attractive. Cloudflare Workers can run Next.js through OpenNext, but the runtime is `workerd`, so database drivers, long-running requests, and adapter compatibility need explicit validation.

Use Hostinger for a simple managed demo if predictable hosting and dashboard simplicity matter more than cloud-native workflow control.

## Platform Fit

### Google Cloud

Best fit for:

- Full Next.js runtime with minimal adapter risk.
- Cloud Run service deployment.
- Cloud SQL, Supabase, or Neon Postgres.
- Google Cloud Storage daily artifact uploads.
- Secret Manager for provider keys and database credentials.
- Future batch jobs or workflow workers.

Risks:

- More cloud configuration than a dashboard-first host.
- Cost controls and IAM need deliberate setup.

### Cloudflare

Best fit for:

- Edge-served presentation app.
- R2-hosted daily JSON/report artifacts.
- Fast global reads of mostly precomputed data.
- Keeping infrastructure small if the app remains read-heavy.

Risks:

- Next.js runs through an adapter on the Workers runtime, not a normal Node server.
- Postgres access should be tested through Hyperdrive or a Worker-compatible database path.
- Long-running LLM or batch processing should stay outside request handlers.

### Hostinger

Best fit for:

- Low-friction managed Next.js hosting.
- Public demos or simple production hosting.
- Teams that prefer hPanel/GitHub deploys over cloud infrastructure.

Risks:

- Less ideal as the control plane for durable workflows, object manifests, and background processing.
- Advanced observability, queueing, and database networking may require VPS-style setup.

## Data Publishing Model

Local batch processing should publish immutable dated artifacts:

```text
daily/2026-05-15/manifest.json
daily/2026-05-15/full-state.json
daily/2026-05-15/summary.json
daily/2026-05-15/report.md
current/manifest.json
```

Only update `current/manifest.json` after all dated artifacts validate and upload successfully. If a daily run fails, the app should keep serving the previous complete manifest.

The manifest contract lives in `src/lib/publishing/manifest.ts`.

## First Deployment Milestones

1. Add a local `daily` command that writes the dated artifact bundle.
2. Add a `publish` command for one target, preferably Google Cloud Storage or Cloudflare R2.
3. Make the app read from `current/manifest.json` before introducing normalized cloud database reads.
4. Add a Drizzle-backed repository for relational queries once the artifact path is stable.
5. Add Cloudflare preview deployment only after API routes, database access, and env handling are validated in `workerd`.
