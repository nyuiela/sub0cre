# CRE Simulate Gateway: run HTTP-triggered workflow via `cre workflow simulate` in a container.
# Backend sets CRE_HTTP_URL to this service to trigger createAgentKey, createMarketsFromBackend, etc.
# Use Debian-based image: CRE CLI binary expects glibc; Alpine (musl) causes "cannot execute: required file not found".
#
# Secrets: Infisical injects env from your project path (default /sub0cre). Users only need the
# Infisical secret token (no CLI login). Pass -e INFISICAL_TOKEN=<secret>. Optional: INFISICAL_PROJECT_ID,
# INFISICAL_ENV=prod, INFISICAL_PATH (default /sub0cre).

FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bash \
  && rm -rf /var/lib/apt/lists/*

# Install Infisical CLI (token-based auth only; no login required)
RUN curl -1sLf "https://artifacts-cli.infisical.com/setup.deb.sh" | bash \
  && apt-get update && apt-get install -y --no-install-recommends infisical \
  && rm -rf /var/lib/apt/lists/*
ENV INFISICAL_DISABLE_UPDATE_CHECK=true

# Install CRE CLI to /opt/cre so PATH is predictable
ENV CRE_INSTALL=/opt/cre
ENV PATH="/opt/cre/bin:${PATH}"
RUN curl -sSL https://cre.chain.link/install.sh | bash

WORKDIR /app

# Project config and workflow (including Infisical project config for path/workspace)
COPY project.yaml contracts.json secrets.yaml .infisical.json ./
COPY payloads ./payloads
COPY markets ./markets
COPY gateway ./gateway
RUN chmod +x /app/gateway/entrypoint.sh

# Install workflow deps and precompile WASM so first request is fast
RUN bun install --cwd ./markets
RUN cd markets && bun x cre-compile main.ts .cre_build_tmp.wasm || true

ENV PORT=8080
ENV CRE_TARGET=docker-settings
ENV INFISICAL_PATH=/sub0cre
EXPOSE 8080

# Entrypoint runs infisical run to fetch project secrets from path /sub0cre and inject into the process.
# Required: -e INFISICAL_TOKEN=<secret>. Optional: -e INFISICAL_PROJECT_ID=, -e INFISICAL_ENV=, -e INFISICAL_PATH=
ENTRYPOINT ["/app/gateway/entrypoint.sh"]
CMD ["bun", "run", "gateway/server.ts"]
