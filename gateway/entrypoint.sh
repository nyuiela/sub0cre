#!/usr/bin/env bash

set -e
BASE="/app"
cd "$BASE"

# Defaults (avoid ENV in Dockerfile so Docker does not warn on "sensitive" keys)
export CRE_CREDENTIALS_PATH="${CRE_CREDENTIALS_PATH:-/home/cre.zip}"
export CRE_USE_VOLUME_AUTH="${CRE_USE_VOLUME_AUTH:-true}"

# CRE credentials: (1) use baked-in /root/.cre if present (image built with --target with-cre);
# (2) else extract from CRE_CREDENTIALS_PATH zip to /app/.cre. CRE CLI uses ~/.cre (HOME).
CRE_HOME="${HOME:-/root}"
if [ -f /root/.cre/cre.yaml ]; then
  echo "[gateway] Using baked-in CRE credentials at /root/.cre"
  export HOME=/root
elif [ -n "${CRE_CREDENTIALS_PATH}" ] && [ -f "$CRE_CREDENTIALS_PATH" ]; then
  echo "[gateway] Extracting CRE credentials from $CRE_CREDENTIALS_PATH to /app/.cre"
  CRE_TMP="/tmp/cre-credentials.zip"
  if cp "$CRE_CREDENTIALS_PATH" "$CRE_TMP" 2>/dev/null; then
    mkdir -p /app/.cre
    if unzip -o -q "$CRE_TMP" -d /app 2>/dev/null; then
      if [ -f /app/.cre/cre.yaml ]; then
        echo "[gateway] CRE credentials extracted; CLI will use ~/.cre (HOME=/app)"
        export HOME=/app
        unset CRE_API_KEY
      elif [ -f /app/cre/cre.yaml ]; then
        rm -rf /app/.cre && mv /app/cre /app/.cre
        echo "[gateway] CRE credentials extracted (cre -> .cre); CLI will use ~/.cre (HOME=/app)"
        export HOME=/app
        unset CRE_API_KEY
      elif [ -f /app/cre.yaml ]; then
        mv /app/cre.yaml /app/.cre/ 2>/dev/null && export HOME=/app && unset CRE_API_KEY
        echo "[gateway] CRE credentials extracted; CLI will use ~/.cre (HOME=/app)"
      else
        echo "[gateway] Warning: zip missing cre.yaml. Create with: cd ~ && zip -r cre.zip .cre" >&2
      fi
    else
      UNZIP_ERR=$(unzip -o -q "$CRE_TMP" -d /app 2>&1) || true
      echo "[gateway] Warning: unzip failed: ${UNZIP_ERR:-unknown}" >&2
    fi
    rm -f "$CRE_TMP"
  else
    echo "[gateway] Warning: could not copy $CRE_CREDENTIALS_PATH (permission denied; ensure user in group 1000)" >&2
  fi
fi

if command -v cre >/dev/null 2>&1; then
  CRE_WHOAMI_HOME="${HOME:-/root}"
  if env HOME="$CRE_WHOAMI_HOME" cre whoami >/dev/null 2>&1; then
    echo "[gateway] CRE auth verified (cre whoami succeeded)"
  elif [ -f /root/.cre/cre.yaml ]; then
    echo "[gateway] Using baked-in /root/.cre (workflow will use it; whoami may fail if token expired or network unavailable)"
  else
    echo "[gateway] CRE auth not verified. Set CRE_API_KEY or CRE_CREDENTIALS_PATH for workflow auth." >&2
  fi
fi

# Load CRE workflow config from a mounted file (e.g. -v /host/cre.json:/config/cre.json -e CRE_CONFIG_FILE=/config/cre.json)
if [ -n "${CRE_CONFIG_FILE:-}" ] && [ -f "$CRE_CONFIG_FILE" ]; then
  echo "[gateway] Copying CRE_CONFIG_FILE to markets/config.docker.json"
  cp "$CRE_CONFIG_FILE" "$BASE/markets/config.docker.json"
fi

if [ -n "${BACKEND_URL:-}" ] && [ -f "$BASE/markets/config.docker.json" ] && command -v jq >/dev/null 2>&1; then
  echo "[gateway] Setting config.backendUrl from BACKEND_URL env"
  jq --arg u "${BACKEND_URL}" '.backendUrl = $u' "$BASE/markets/config.docker.json" > "$BASE/markets/config.docker.json.tmp" && mv "$BASE/markets/config.docker.json.tmp" "$BASE/markets/config.docker.json"
fi

# In-container cron: use CRE_CRON_SCHEDULE if set, else derive 5-field from config, else default */8 (every 8 min).
# Default */8 so deploy logs show current build. Config is 6-field (sec min hour day month dow); host cron is 5-field.
CRON_SCHEDULE="${CRE_CRON_SCHEDULE:-}"
if [ -n "$CRON_SCHEDULE" ]; then
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
        echo "[gateway] Config schedule has $PARTS fields (expected 5 or 6); using default */8"
        CRON_SCHEDULE="*/8 * * * *"
      fi
    else
      CRON_SCHEDULE="*/8 * * * *"
      echo "[gateway] No config schedule; using default (5-field): $CRON_SCHEDULE"
    fi
  else
    CRON_SCHEDULE="*/8 * * * *"
    echo "[gateway] No config; using default CRE cron (5-field): $CRON_SCHEDULE"
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