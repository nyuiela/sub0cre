#!/usr/bin/env bash
# Trigger the local CRE simulate gateway (createMarketsFromBackend). Used by in-container cron.
# Set GATEWAY_PORT (default 8080) and GATEWAY_HOST (default 127.0.0.1) if needed.
set -e
PORT="${GATEWAY_PORT:-8080}"
HOST="${GATEWAY_HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}"
# Same payload the backend would send: action + broadcast so markets are created on-chain
PAYLOAD='{"action":"createMarketsFromBackend","broadcast":true}'
curl -sS -X POST "${URL}" -H "Content-Type: application/json" -d "${PAYLOAD}" >/dev/null 2>&1 || true
