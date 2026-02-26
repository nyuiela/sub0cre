#!/usr/bin/env bash
# Infisical entrypoint: inject env from Infisical project using INFISICAL_TOKEN (no CLI login).
# Optional: INFISICAL_PROJECT_ID (machine identity), INFISICAL_ENV (e.g. prod), INFISICAL_PATH (default: /sub0cre).
set -e
BASE="/app"
cd "$BASE"

if [ -z "${INFISICAL_TOKEN:-}" ]; then
  echo "[gateway] ERROR: INFISICAL_TOKEN is not set. Pass -e INFISICAL_TOKEN=<secret> to load secrets from Infisical." >&2
  exit 1
fi

INFISICAL_ARGS=(--path="${INFISICAL_PATH:-/sub0cre}" --include-imports=false)
[ -n "${INFISICAL_PROJECT_ID:-}" ] && INFISICAL_ARGS+=(--projectId="$INFISICAL_PROJECT_ID")
[ -n "${INFISICAL_ENV:-}" ] && INFISICAL_ARGS+=(--env="$INFISICAL_ENV")
echo "[gateway] infisical run ${INFISICAL_ARGS[*]} -- $*" >&2
exec infisical run "${INFISICAL_ARGS[@]}" -- "$@"
