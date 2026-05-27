#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 polyvise|debatefrog" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_ENV="$ROOT_DIR/.env.local"

case "$1" in
  polyvise)
    APP_ENV="$ROOT_DIR/apps/polyvise-web/local.secrets.env"
    ;;
  debatefrog)
    APP_ENV="$ROOT_DIR/apps/debatefrog-web/local.secrets.env"
    ;;
  *)
    echo "Usage: $0 polyvise|debatefrog" >&2
    exit 1
    ;;
esac

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

POLYVISE_ENABLE_MOCK_LLM="${POLYVISE_ENABLE_MOCK_LLM:-false}"
POLYVISE_QUICK_MODEL="${POLYVISE_QUICK_MODEL:-google/gemini-2.5-flash}"
POLYVISE_DEEP_MODEL="${POLYVISE_DEEP_MODEL:-google/gemini-2.5-flash}"
POLYVISE_YES_MODEL="${POLYVISE_YES_MODEL:-$POLYVISE_QUICK_MODEL}"
POLYVISE_NO_MODEL="${POLYVISE_NO_MODEL:-$POLYVISE_DEEP_MODEL}"
POLYVISE_JUDGE_MODEL="${POLYVISE_JUDGE_MODEL:-openai/gpt-4.1}"
POLYVISE_LLM_TIMEOUT_MS="${POLYVISE_LLM_TIMEOUT_MS:-45000}"
POLYVISE_LLM_MAX_TOKENS="${POLYVISE_LLM_MAX_TOKENS:-1400}"
POLYVISE_OPENROUTER_MODEL_OPTIONS="${POLYVISE_OPENROUTER_MODEL_OPTIONS:-}"

present_or_missing() {
  local value="${1:-}"
  if [[ -n "$value" ]]; then
    echo "present"
  else
    echo "missing"
  fi
}

echo "App: $1"
echo "Secrets file: $APP_ENV"
echo "OPENROUTER_API_KEY: $(present_or_missing "${OPENROUTER_API_KEY:-}")"
echo "BRAVE_SEARCH_API_KEY: $(present_or_missing "${BRAVE_SEARCH_API_KEY:-}")"
echo "POLYVISE_ENABLE_MOCK_LLM: $POLYVISE_ENABLE_MOCK_LLM"
echo "POLYVISE_QUICK_MODEL: $POLYVISE_QUICK_MODEL"
echo "POLYVISE_DEEP_MODEL: $POLYVISE_DEEP_MODEL"
echo "POLYVISE_YES_MODEL: $POLYVISE_YES_MODEL"
echo "POLYVISE_NO_MODEL: $POLYVISE_NO_MODEL"
echo "POLYVISE_JUDGE_MODEL: $POLYVISE_JUDGE_MODEL"
echo "POLYVISE_LLM_TIMEOUT_MS: $POLYVISE_LLM_TIMEOUT_MS"
echo "POLYVISE_LLM_MAX_TOKENS: $POLYVISE_LLM_MAX_TOKENS"
echo "POLYVISE_OPENROUTER_MODEL_OPTIONS: ${POLYVISE_OPENROUTER_MODEL_OPTIONS:-default model set}"
