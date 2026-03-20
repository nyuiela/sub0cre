# CRE Simulate Gateway: run HTTP-triggered workflow via `cre workflow simulate` in a container.
# Backend sets CRE_HTTP_URL to this service to trigger createAgentKey, createMarketsFromBackend, etc.
# Use Debian-based image: CRE CLI binary expects glibc; Alpine (musl) causes "cannot execute: required file not found".
#
# Secrets: Infisical injects env from your project path (default /sub0cre). Users only need the
# Infisical secret token (no CLI login). Pass -e INFISICAL_TOKEN=<secret>. Optional: INFISICAL_PROJECT_ID,
# INFISICAL_ENV=prod, INFISICAL_PATH (default /sub0cre).
#
# Versions: Bun = latest 1.x from oven/bun:1 (rebuild to get newer 1.x). CRE = latest from
# https://cre.chain.link/install.sh (fetches GitHub releases/latest at build time). To pin CRE, run
# the install script with a version: curl -sSL https://cre.chain.link/install.sh | bash -s -- v1.2.3

FROM oven/bun:1 AS base

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bash cron jq unzip \
  && rm -rf /var/lib/apt/lists/*

# Render secret files at /etc/secrets require app user in group 1000; add root to group 1000
RUN usermod -a -G 1000 root 2>/dev/null || true

# Install Infisical CLI (token-based auth only; no login required)
RUN curl -1sLf "https://artifacts-cli.infisical.com/setup.deb.sh" | bash \
  && apt-get update && apt-get install -y --no-install-recommends infisical \
  && rm -rf /var/lib/apt/lists/*
ENV INFISICAL_DISABLE_UPDATE_CHECK=true

# Install CRE CLI to /opt/cre (pinned to v1.6.0 — update this version when a new release is available)
ENV CRE_INSTALL=/opt/cre
ENV PATH="/opt/cre/bin:${PATH}"
RUN curl -sSL https://cre.chain.link/install.sh | bash -s -- v1.6.0

WORKDIR /app

# Project config and workflow (including Infisical project config for path/workspace)
COPY project.yaml contracts.json secrets.yaml .infisical.json ./
COPY payloads ./payloads
COPY markets ./markets
COPY gateway ./gateway
RUN chmod +x /app/gateway/entrypoint.sh /app/gateway/cron-trigger.sh

# Default CRE config. CRE_CREDENTIALS_PATH and CRE_USE_VOLUME_AUTH defaults set in entrypoint (avoids Docker ENV secret warnings).
# Cloud Run: mount cre.zip and set CRE_CREDENTIALS_PATH to its path; entrypoint unzips to /app/.cre.
RUN mkdir -p /config && cp /app/markets/config.docker.json /config/cre.json
ENV CRE_CONFIG_FILE=/config/cre.json

# Install workflow deps and precompile WASM so first request is fast
RUN bun install --cwd ./markets
RUN cd markets && bun x cre-compile main.ts .cre_build_tmp.wasm || true

ENV PORT=8080
ENV CRE_TARGET=docker-settings
ENV INFISICAL_PATH=/sub0cre
# Run simulate with --broadcast so create-market and seed get real onchain tx hashes. Override with -e CRE_GATEWAY_BROADCAST=false to dry-run.
ENV CRE_GATEWAY_BROADCAST=true
EXPOSE 8080

# Entrypoint runs infisical run to fetch project secrets from path /sub0cre and inject into the process.
# Required: -e INFISICAL_TOKEN=<secret>. Optional: -e INFISICAL_PROJECT_ID=, -e INFISICAL_ENV=, -e INFISICAL_PATH=
ENTRYPOINT ["/app/gateway/entrypoint.sh"]
CMD ["bun", "run", "gateway/server.ts"]

# Bake CRE credentials into image: cre.zip must be in this directory (sub0cre/).
# Zip may have top-level "cre" (no dot) or ".cre"; CRE CLI requires ~/.cre (with dot).
# We always end up with /root/.cre/cre.yaml so the CLI finds it.
FROM base AS with-cre
COPY cre.zip /tmp/cre.zip
RUN unzip -o /tmp/cre.zip -d /root && \
  if [ -d /root/cre ]; then rm -rf /root/.cre 2>/dev/null; mv /root/cre /root/.cre; fi && \
  rm -f /tmp/cre.zip && \
  test -f /root/.cre/cre.yaml || (echo "ERROR: /root/.cre/cre.yaml missing; zip must contain .cre/cre.yaml or cre/cre.yaml" && exit 1)

# Default build: always use image with baked-in /root/.cre (requires cre.zip in build context).
FROM with-cre
