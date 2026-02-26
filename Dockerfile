# CRE Simulate Gateway: run HTTP-triggered workflow via `cre workflow simulate` in a container.
# Backend sets CRE_HTTP_URL to this service to trigger createAgentKey, createMarketsFromBackend, etc.
# Use Debian-based image: CRE CLI binary expects glibc; Alpine (musl) causes "cannot execute: required file not found".

FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bash && rm -rf /var/lib/apt/lists/*

# Install CRE CLI to /opt/cre so PATH is predictable
ENV CRE_INSTALL=/opt/cre
ENV PATH="/opt/cre/bin:${PATH}"
RUN curl -sSL https://cre.chain.link/install.sh | bash

WORKDIR /app

# Project config and workflow
COPY project.yaml contracts.json secrets.yaml ./
COPY payloads ./payloads
COPY markets ./markets
COPY gateway ./gateway

# Install workflow deps and precompile WASM so first request is fast
RUN bun install --cwd ./markets
RUN cd markets && bun x cre-compile main.ts .cre_build_tmp.wasm || true

ENV PORT=8080
ENV CRE_TARGET=docker-settings

EXPOSE 8080

# Auth: run "cre login" on the host once, then run this container with -v "$HOME/.cre:/root/.cre"
# so the CLI can use your saved credentials. If you have CRE_API_KEY, pass -e CRE_API_KEY=... instead.
# Also pass CRE_ETH_PRIVATE_KEY, BACKEND_SIGNER_PRIVATE_KEY, HTTP_API_KEY, BACKEND_API_KEY via -e or --env-file.
CMD ["bun", "run", "gateway/server.ts"]
