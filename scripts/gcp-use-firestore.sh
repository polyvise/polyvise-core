#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 debatefrog|debatefrog-preview|polyvise" >&2
  exit 1
fi

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GCP_REGION:-us-central1}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

case "$1" in
  debatefrog)
    SERVICE="${GCP_DEBATEFROG_SERVICE:-debatefrog-web}"
    ;;
  debatefrog-preview)
    SERVICE="${GCP_DEBATEFROG_PREVIEW_SERVICE:-debatefrog-preview-web}"
    ;;
  polyvise)
    SERVICE="${GCP_POLYVISE_SERVICE:-polyvise-web}"
    ;;
  *)
    echo "Usage: $0 debatefrog|debatefrog-preview|polyvise" >&2
    exit 1
    ;;
esac

SERVICE_ACCOUNT="$(gcloud run services describe "$SERVICE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format "value(spec.template.spec.serviceAccountName)")"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:$SERVICE_ACCOUNT" \
  --role roles/datastore.user >/dev/null

gcloud run services update "$SERVICE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --update-env-vars "POLYVISE_REPOSITORY=firestore,FIRESTORE_PROJECT_ID=$PROJECT_ID"

echo "Configured $SERVICE to use Firestore persistence."
