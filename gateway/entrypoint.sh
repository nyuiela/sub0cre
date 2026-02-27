#!/usr/bin/env bash
# Optional Infisical: if INFISICAL_TOKEN is set, inject env from Infisical. Otherwise run with env from docker (--env-file or -e).
# Optional: CRE_CONFIG_FILE (path to JSON) copied to markets/config.docker.json so workflow uses it.
# Optional: CRE_CRON_SCHEDULE (cron expr, e.g. "*/10 * * * *") runs createMarketsFromBackend at schedule inside the container.
# CRE CLI: try to update to latest so container doesn't warn about newer version (non-fatal).
set -e
BASE="/app"
cd "$BASE"

if command -v cre >/dev/null 2>&1; then
  echo "[gateway] Checking CRE CLI version and updating if available..."
  cre update 2>/dev/null || true
fi

# Load CRE workflow config from a mounted file (e.g. -v /host/cre.json:/config/cre.json -e CRE_CONFIG_FILE=/config/cre.json)
if [ -n "${CRE_CONFIG_FILE:-}" ] && [ -f "$CRE_CONFIG_FILE" ]; then
  echo "[gateway] Copying CRE_CONFIG_FILE to markets/config.docker.json"
  cp "$CRE_CONFIG_FILE" "$BASE/markets/config.docker.json"
fi

# In-container cron: use CRE_CRON_SCHEDULE if set, else derive 5-field cron from config's schedule (6-field -> 5-field).
# Config schedule is 6-field (sec min hour day month dow); host cron is 5-field (min hour day month dow).
CRON_SCHEDULE=""
if [ -n "${CRE_CRON_SCHEDULE:-}" ]; then
  CRON_SCHEDULE="$CRE_CRON_SCHEDULE"
  echo "[gateway] Using CRE_CRON_SCHEDULE (5-field): $CRON_SCHEDULE"
else
  CONFIG_JSON="$BASE/markets/config.docker.json"
  if [ -f "$CONFIG_JSON" ] && command -v jq >/dev/null 2>&1; then
    RAW_SCHEDULE=$(jq -r '.schedule // empty' "$CONFIG_JSON" 2>/dev/null)
    if [ -n "$RAW_SCHEDULE" ]; then
      # 6-field (sec min hour day month dow) -> drop first field -> 5-field (min hour day month dow)
      # 5-field -> use as-is. Other -> leave empty (fallback: no cron).
      PARTS=$(echo "$RAW_SCHEDULE" | wc -w)
      if [ "$PARTS" -eq 6 ]; then
        CRON_SCHEDULE=$(echo "$RAW_SCHEDULE" | awk '{ print $2, $3, $4, $5, $6 }')
        echo "[gateway] Using config schedule (6->5 field): \"$RAW_SCHEDULE\" -> \"$CRON_SCHEDULE\""
      elif [ "$PARTS" -eq 5 ]; then
        CRON_SCHEDULE="$RAW_SCHEDULE"
        echo "[gateway] Using config schedule (5-field): $CRON_SCHEDULE"
      else
        echo "[gateway] Config schedule has $PARTS fields (expected 5 or 6); skipping cron"
      fi
    fi
  fi
fi

if [ -n "$CRON_SCHEDULE" ] && command -v crontab >/dev/null 2>&1; then
  echo "[gateway] Installing crontab: $CRON_SCHEDULE $BASE/gateway/cron-trigger.sh"
  export GATEWAY_PORT="${PORT:-8080}"
  (echo "$CRON_SCHEDULE $BASE/gateway/cron-trigger.sh"; echo "") | crontab -
  cron
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
