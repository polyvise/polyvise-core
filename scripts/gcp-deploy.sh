#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 polyvise|debatefrog" >&2
  exit 1
fi

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GCP_REGION:-us-central1}"
ARTIFACT_REPO="${GCP_ARTIFACT_REPO:-polyvise}"
MAX_INSTANCES="${GCP_CLOUD_RUN_MAX_INSTANCES:-3}"
MEMORY="${GCP_CLOUD_RUN_MEMORY:-1Gi}"
CPU="${GCP_CLOUD_RUN_CPU:-1}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

case "$1" in
  polyvise)
    SERVICE="${GCP_POLYVISE_SERVICE:-polyvise-web}"
    APP_WORKSPACE="@polyvise/polyvise-web"
    APP_DIR="apps/polyvise-web"
    SITE_URL="${POLYVISE_SITE_URL:-https://polyvise.com}"
    LLM_MAX_TOKENS="${POLYVISE_LLM_MAX_TOKENS:-1400}"
    ;;
  debatefrog)
    SERVICE="${GCP_DEBATEFROG_SERVICE:-debatefrog-web}"
    APP_WORKSPACE="@polyvise/debatefrog-web"
    APP_DIR="apps/debatefrog-web"
    SITE_URL="${DEBATEFROG_SITE_URL:-https://debatefrog.com}"
    LLM_MAX_TOKENS="${POLYVISE_LLM_MAX_TOKENS:-1000}"
    ;;
  *)
    echo "Usage: $0 polyvise|debatefrog" >&2
    exit 1
    ;;
esac

SHORT_SHA="$(git rev-parse --short HEAD)"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$ARTIFACT_REPO/$SERVICE:$SHORT_SHA"

echo "Building $APP_WORKSPACE -> $IMAGE"
gcloud builds submit \
  --config cloudbuild.deploy.yaml \
  --substitutions "_IMAGE=$IMAGE,_APP_WORKSPACE=$APP_WORKSPACE,_APP_DIR=$APP_DIR" \
  --project "$PROJECT_ID"

echo "Deploying Cloud Run service: $SERVICE"
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --platform managed \
  --allow-unauthenticated \
  --memory "$MEMORY" \
  --cpu "$CPU" \
  --concurrency 20 \
  --min-instances 0 \
  --max-instances "$MAX_INSTANCES" \
  --timeout 300 \
  --set-env-vars "NEXT_PUBLIC_SITE_URL=$SITE_URL,POLYVISE_ENABLE_MOCK_LLM=${POLYVISE_ENABLE_MOCK_LLM:-true},POLYVISE_EVIDENCE_PROVIDER=${POLYVISE_EVIDENCE_PROVIDER:-mock},POLYVISE_QUICK_MODEL=${POLYVISE_QUICK_MODEL:-openai/gpt-4o-mini},POLYVISE_DEEP_MODEL=${POLYVISE_DEEP_MODEL:-openai/gpt-4o-mini},POLYVISE_JUDGE_MODEL=${POLYVISE_JUDGE_MODEL:-openai/gpt-4o-mini},POLYVISE_LLM_TIMEOUT_MS=${POLYVISE_LLM_TIMEOUT_MS:-45000},POLYVISE_LLM_MAX_TOKENS=$LLM_MAX_TOKENS"

echo "Deployment complete."
gcloud run services describe "$SERVICE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format "value(status.url)"
