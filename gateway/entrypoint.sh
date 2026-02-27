#!/usr/bin/env bash
# Optional Infisical: if INFISICAL_TOKEN is set, inject env from Infisical. Otherwise run with env from docker (--env-file or -e).
# Optional: INFISICAL_PROJECT_ID, INFISICAL_ENV (e.g. prod), INFISICAL_PATH (default: /sub0cre).
# CRE CLI: try to update to latest so container doesn't warn about newer version (non-fatal).
set -e
BASE="/app"
cd "$BASE"

if command -v cre >/dev/null 2>&1; then
  echo "[gateway] Checking CRE CLI version and updating if available..."
  cre update 2>/dev/null || true
fi

if [ -n "${INFISICAL_TOKEN:-}" ]; then
  INFISICAL_ARGS=(--path="${INFISICAL_PATH:-/sub0cre}" --include-imports=false)
  [ -n "${INFISICAL_PROJECT_ID:-}" ] && INFISICAL_ARGS+=(--projectId="$INFISICAL_PROJECT_ID")
  [ -n "${INFISICAL_ENV:-}" ] && INFISICAL_ARGS+=(--env="$INFISICAL_ENV")
  echo "[gateway] infisical run ${INFISICAL_ARGS[*]} -- $*" >&2
  exec infisical run "${INFISICAL_ARGS[@]}" -- "$@"
fi

echo "[gateway] Running without Infisical; using env from docker (--env-file or -e)." >&2
exec "$@"
