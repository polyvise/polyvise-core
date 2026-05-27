#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 polyvise|debatefrog|debatefrog-preview" >&2
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
    DEFAULT_REPOSITORY="memory"
    DEFAULT_ENABLE_MOCK_LLM="true"
    DEFAULT_EVIDENCE_PROVIDER="mock"
    APP_CHANNEL="${POLYVISE_APP_CHANNEL:-production}"
    ;;
  debatefrog)
    SERVICE="${GCP_DEBATEFROG_SERVICE:-debatefrog-web}"
    APP_WORKSPACE="@polyvise/debatefrog-web"
    APP_DIR="apps/debatefrog-web"
    SITE_URL="${DEBATEFROG_SITE_URL:-https://debatefrog.com}"
    LLM_MAX_TOKENS="${POLYVISE_LLM_MAX_TOKENS:-2200}"
    DEFAULT_REPOSITORY="memory"
    DEFAULT_ENABLE_MOCK_LLM="true"
    DEFAULT_EVIDENCE_PROVIDER="mock"
    APP_CHANNEL="${POLYVISE_APP_CHANNEL:-production}"
    OPENROUTER_SECRET="${GCP_DEBATEFROG_OPENROUTER_SECRET:-debatefrog-openrouter-api-key}"
    TAVILY_SECRET="${GCP_DEBATEFROG_TAVILY_SECRET:-debatefrog-tavily-api-key}"
    ;;
  debatefrog-preview)
    SERVICE="${GCP_DEBATEFROG_PREVIEW_SERVICE:-debatefrog-preview-web}"
    APP_WORKSPACE="@polyvise/debatefrog-web"
    APP_DIR="apps/debatefrog-web"
    SITE_URL="${DEBATEFROG_PREVIEW_SITE_URL:-https://preview.debatefrog.com}"
    LLM_MAX_TOKENS="${POLYVISE_LLM_MAX_TOKENS:-2200}"
    DEFAULT_REPOSITORY="firestore"
    DEFAULT_ENABLE_MOCK_LLM="false"
    DEFAULT_EVIDENCE_PROVIDER="tavily"
    APP_CHANNEL="${POLYVISE_APP_CHANNEL:-preview}"
    OPENROUTER_SECRET="${GCP_DEBATEFROG_PREVIEW_OPENROUTER_SECRET:-${GCP_DEBATEFROG_OPENROUTER_SECRET:-debatefrog-openrouter-api-key}}"
    TAVILY_SECRET="${GCP_DEBATEFROG_PREVIEW_TAVILY_SECRET:-${GCP_DEBATEFROG_TAVILY_SECRET:-debatefrog-tavily-api-key}}"
    ;;
  *)
    echo "Usage: $0 polyvise|debatefrog|debatefrog-preview" >&2
    exit 1
    ;;
esac

SHORT_SHA="$(git rev-parse --short HEAD)"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$ARTIFACT_REPO/$SERVICE:$SHORT_SHA"
SECRET_ARGS=()
if [[ -n "${OPENROUTER_SECRET:-}" && -n "${TAVILY_SECRET:-}" ]]; then
  SECRET_ARGS=(--update-secrets "OPENROUTER_API_KEY=$OPENROUTER_SECRET:latest,TAVILY_API_KEY=$TAVILY_SECRET:latest")
fi

echo "Building $APP_WORKSPACE -> $IMAGE"
gcloud builds submit \
  --config cloudbuild.deploy.yaml \
  --substitutions "_IMAGE=$IMAGE,_APP_WORKSPACE=$APP_WORKSPACE,_APP_DIR=$APP_DIR,_NEXT_PUBLIC_SITE_URL=$SITE_URL,_NEXT_PUBLIC_DEPLOY_CHANNEL=$APP_CHANNEL" \
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
  --set-env-vars "^|^NEXT_PUBLIC_SITE_URL=$SITE_URL|NEXT_PUBLIC_DEPLOY_CHANNEL=$APP_CHANNEL|POLYVISE_APP_CHANNEL=$APP_CHANNEL|POLYVISE_REPOSITORY=${POLYVISE_REPOSITORY:-$DEFAULT_REPOSITORY}|FIRESTORE_PROJECT_ID=${FIRESTORE_PROJECT_ID:-$PROJECT_ID}|POLYVISE_ENABLE_MOCK_LLM=${POLYVISE_ENABLE_MOCK_LLM:-$DEFAULT_ENABLE_MOCK_LLM}|POLYVISE_EVIDENCE_PROVIDER=${POLYVISE_EVIDENCE_PROVIDER:-$DEFAULT_EVIDENCE_PROVIDER}|POLYVISE_QUICK_MODEL=${POLYVISE_QUICK_MODEL:-google/gemini-2.5-flash}|POLYVISE_DEEP_MODEL=${POLYVISE_DEEP_MODEL:-google/gemini-2.5-flash}|POLYVISE_YES_MODEL=${POLYVISE_YES_MODEL:-${POLYVISE_QUICK_MODEL:-google/gemini-2.5-flash}}|POLYVISE_NO_MODEL=${POLYVISE_NO_MODEL:-${POLYVISE_DEEP_MODEL:-google/gemini-2.5-flash}}|POLYVISE_JUDGE_MODEL=${POLYVISE_JUDGE_MODEL:-openai/gpt-4.1}|POLYVISE_OPENROUTER_MODEL_OPTIONS=${POLYVISE_OPENROUTER_MODEL_OPTIONS:-}|POLYVISE_LLM_TIMEOUT_MS=${POLYVISE_LLM_TIMEOUT_MS:-45000}|POLYVISE_LLM_MAX_TOKENS=$LLM_MAX_TOKENS" \
  "${SECRET_ARGS[@]}"

echo "Deployment complete."
gcloud run services describe "$SERVICE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format "value(status.url)"
