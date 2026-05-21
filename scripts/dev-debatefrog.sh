#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_ENV="$ROOT_DIR/.env.local"
APP_ENV="$ROOT_DIR/apps/debatefrog-web/local.secrets.env"

if [[ ! -f "$APP_ENV" ]]; then
  echo "Missing $APP_ENV" >&2
  exit 1
fi

set -a
if [[ -f "$ROOT_ENV" ]]; then
  source "$ROOT_ENV"
fi
source "$APP_ENV"
set +a

export POLYVISE_ENABLE_MOCK_LLM="${POLYVISE_ENABLE_MOCK_LLM:-false}"
export POLYVISE_QUICK_MODEL="${POLYVISE_QUICK_MODEL:-google/gemini-2.5-flash}"
export POLYVISE_DEEP_MODEL="${POLYVISE_DEEP_MODEL:-google/gemini-2.5-flash}"
export POLYVISE_YES_MODEL="${POLYVISE_YES_MODEL:-$POLYVISE_QUICK_MODEL}"
export POLYVISE_NO_MODEL="${POLYVISE_NO_MODEL:-$POLYVISE_DEEP_MODEL}"
export POLYVISE_JUDGE_MODEL="${POLYVISE_JUDGE_MODEL:-openai/gpt-4o-mini}"
export POLYVISE_LLM_TIMEOUT_MS="${POLYVISE_LLM_TIMEOUT_MS:-45000}"
export POLYVISE_LLM_MAX_TOKENS="${POLYVISE_LLM_MAX_TOKENS:-2200}"

cd "$ROOT_DIR"
exec npm run dev:debatefrog
