# Deployment Direction

Polyvise should be deployable as two independent branded apps backed by the same engine package and cloud-hosted data. The likely production shape is:

`local batch producer -> cloud object store / database -> stateless Next.js app`

The cloud app should not depend on reaching a local machine. Local jobs should publish validated daily artifacts to the cloud, then the app should read the newest complete manifest.

Runtime 1 is the priority: interactive debate requests in the cloud for `polyvise.com` and eventually `debatefrog.com`, with cost limits. Runtime 2 comes later: local/backend batch analysis that publishes static artifacts.

## Recommended Path

Start with Google Cloud Run for the first serious deployment of `apps/polyvise-web`. It runs a normal Node.js/Next.js service, keeps Docker available as an escape hatch, and fits future Postgres persistence and background workflow needs cleanly.

Use Cloudflare as a parallel proof of concept for `apps/debatefrog-web` if edge hosting and R2 are attractive. Cloudflare Workers can run Next.js through OpenNext, but the runtime is `workerd`, so database drivers, long-running requests, and adapter compatibility need explicit validation.

Use Hostinger for a simple managed demo if predictable hosting and dashboard simplicity matter more than cloud-native workflow control.

## Google Cloud Run Quickstart

The repo includes a container-based Cloud Run path for both branded apps:

```bash
export GCP_PROJECT_ID="your-gcp-project-id"
export GCP_REGION="us-central1"

./scripts/gcp-bootstrap.sh
./scripts/gcp-deploy.sh polyvise
./scripts/gcp-deploy.sh debatefrog
```

The bootstrap script enables the required APIs and creates a Docker Artifact Registry repository named `polyvise` by default. The deploy script builds the selected workspace with Cloud Build, pushes the image to Artifact Registry, and deploys it to Cloud Run.

## GitHub Deploys

`main` deploys Debatefrog through `.github/workflows/deploy-debatefrog.yml`. The workflow uses GitHub OIDC with Google Cloud Workload Identity Federation instead of a long-lived JSON key. It runs tests and typechecks before deploying the Cloud Run service with `./scripts/gcp-deploy.sh debatefrog`.

The Google Cloud trust is restricted to the `jaybrownlee/polyvise` repository on `refs/heads/main` and impersonates:

```bash
github-actions-deployer@websites-prod-496602.iam.gserviceaccount.com
```

Default deployment guardrails:

- `min-instances=0` so low-traffic services can scale down.
- `max-instances=3` to avoid accidental cost spikes while the product is early.
- `POLYVISE_ENABLE_MOCK_LLM=true` and mock evidence by default for cheap smoke deployments.
- `timeout=300` to leave room for current inline debate runs.

Override defaults with environment variables:

```bash
export GCP_CLOUD_RUN_MAX_INSTANCES="5"
export GCP_CLOUD_RUN_MEMORY="1Gi"
export GCP_CLOUD_RUN_CPU="1"
export POLYVISE_ENABLE_MOCK_LLM="false"
export POLYVISE_EVIDENCE_PROVIDER="tavily"
export POLYVISE_SITE_URL="https://polyvise.com"
export DEBATEFROG_SITE_URL="https://debatefrog.com"
```

Secrets such as `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, and `DATABASE_URL` should be stored in Secret Manager and attached to Cloud Run with `--set-secrets` once production persistence and live providers are enabled. Do not pass provider keys through `--set-env-vars`.

## Firestore Persistence

Firestore is the preferred low-cost GCP-native persistence path for the early app. When `POLYVISE_REPOSITORY=firestore`, the debate engine stores each full debate record in Firestore. Without that setting, local development and smoke deployments continue to use the in-memory repository.

Enable Firestore once per project, then attach it to a service:

```bash
./scripts/gcp-enable-firestore.sh
./scripts/gcp-use-firestore.sh debatefrog
```

Use `./scripts/gcp-use-firestore.sh polyvise` for the Polyvise service.

## Tavily Search

Add `TAVILY_API_KEY` to `local.ops.secrets.env`, then attach it to Cloud Run:

```bash
./scripts/gcp-set-tavily.sh debatefrog
```

Use `./scripts/gcp-set-tavily.sh polyvise` for the Polyvise service.

## Postgres Persistence

When `DATABASE_URL` is present, the debate engine uses the Postgres-backed repository. Without it, local development and smoke deployments continue to use the in-memory repository.

Add the database URL to the ignored root ops file:

```bash
DATABASE_URL="postgres://..."
```

Then migrate the database and attach it to a Cloud Run service:

```bash
./scripts/db-migrate.sh
./scripts/gcp-set-database.sh debatefrog
```

Use `./scripts/gcp-set-database.sh polyvise` for the Polyvise service.

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

The manifest contract lives in `packages/debate-engine/src/publishing/manifest.ts`.

## First Deployment Milestones

1. Add a local `daily` command that writes the dated artifact bundle.
2. Add a `publish` command for one target, preferably Google Cloud Storage or Cloudflare R2.
3. Make the app read from `current/manifest.json` before introducing normalized cloud database reads.
4. Add a Drizzle-backed repository for relational queries once the artifact path is stable.
5. Add Cloudflare preview deployment only after API routes, database access, and env handling are validated in `workerd`.
