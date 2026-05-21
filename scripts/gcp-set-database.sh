#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 debatefrog|debatefrog-preview|polyvise" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPS_ENV="$ROOT_DIR/local.ops.secrets.env"
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GCP_REGION:-us-central1}"

if [[ -f "$OPS_ENV" ]]; then
  set -a
  source "$OPS_ENV"
  set +a
fi

if [[ -z "$PROJECT_ID" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Set DATABASE_URL or add it to local.ops.secrets.env before configuring Cloud Run." >&2
  exit 1
fi

case "$1" in
  debatefrog)
    SERVICE="${GCP_DEBATEFROG_SERVICE:-debatefrog-web}"
    SECRET="${GCP_DEBATEFROG_DATABASE_SECRET:-debatefrog-database-url}"
    ;;
  debatefrog-preview)
    SERVICE="${GCP_DEBATEFROG_PREVIEW_SERVICE:-debatefrog-preview-web}"
    SECRET="${GCP_DEBATEFROG_PREVIEW_DATABASE_SECRET:-${GCP_DEBATEFROG_DATABASE_SECRET:-debatefrog-database-url}}"
    ;;
  polyvise)
    SERVICE="${GCP_POLYVISE_SERVICE:-polyvise-web}"
    SECRET="${GCP_POLYVISE_DATABASE_SECRET:-polyvise-database-url}"
    ;;
  *)
    echo "Usage: $0 debatefrog|debatefrog-preview|polyvise" >&2
    exit 1
    ;;
esac

if ! gcloud secrets describe "$SECRET" --project "$PROJECT_ID" >/dev/null 2>&1; then
  printf %s "$DATABASE_URL" | gcloud secrets create "$SECRET" \
    --project "$PROJECT_ID" \
    --replication-policy=automatic \
    --data-file=- >/dev/null
  echo "Created secret $SECRET"
else
  printf %s "$DATABASE_URL" | gcloud secrets versions add "$SECRET" \
    --project "$PROJECT_ID" \
    --data-file=- >/dev/null
  echo "Added new version for secret $SECRET"
fi

SERVICE_ACCOUNT="$(gcloud run services describe "$SERVICE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format "value(spec.template.spec.serviceAccountName)")"

gcloud secrets add-iam-policy-binding "$SECRET" \
  --project "$PROJECT_ID" \
  --member "serviceAccount:$SERVICE_ACCOUNT" \
  --role roles/secretmanager.secretAccessor >/dev/null

gcloud run services update "$SERVICE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --set-secrets "DATABASE_URL=$SECRET:latest"

echo "Attached DATABASE_URL secret to $SERVICE."
