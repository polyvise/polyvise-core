#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
LOCATION="${FIRESTORE_LOCATION:-nam5}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

gcloud services enable firestore.googleapis.com --project "$PROJECT_ID"

if ! gcloud firestore databases describe --database="(default)" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud firestore databases create \
    --database="(default)" \
    --location="$LOCATION" \
    --type=firestore-native \
    --project "$PROJECT_ID"
fi

echo "Firestore is ready for project $PROJECT_ID."
