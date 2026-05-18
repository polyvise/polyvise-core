#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPS_ENV="$ROOT_DIR/local.ops.secrets.env"

if [[ -f "$OPS_ENV" ]]; then
  set -a
  source "$OPS_ENV"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Set DATABASE_URL or add it to local.ops.secrets.env before running migrations." >&2
  exit 1
fi

cd "$ROOT_DIR"
exec npm run db:migrate
