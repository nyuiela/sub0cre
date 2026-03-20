# Set the default CRE target environment
TARGET := "staging-settings"

# Default command when typing just `just`
default:
    @just --list


# Install dependencies and setup the WASM toolchain (run from sub0cre; includes cre-setup in markets)
install:
    bun install --cwd ./markets

# Compile the markets workflow to WASM (creates wasm/workflow.wasm).
# Run this to verify the full CRE build pipeline before simulate/deploy.
compile:
    mkdir -p markets/wasm
    cd markets && bun cre-compile main.ts wasm/workflow.wasm

# Type-check all workflow TypeScript without emitting output (fast, no WASM build).
# Useful during active development to catch type errors quickly.
typecheck:
    cd markets && bun tsc --noEmit

# Type-check and watch for changes
typecheck-watch:
    cd markets && bun tsc --noEmit --watch

# Build workflow to WASM so CRE CLI can run simulate (avoids "no such file or directory" for .cre_build_tmp.wasm).
# Run from sub0cre. Tries cre-compile; if .cre_build_tmp.wasm is missing, copies main.wasm so simulate can run.
#build-workflow:
#    cd markets && bun x cre-compile main.ts .cre_build_tmp.wasm || true
#    cd markets && test -f .cre_build_tmp.wasm || cp -f main.wasm .cre_build_tmp.wasm

# Run the interactive workflow simulation (build-workflow recommended first if simulate fails)
sim:
    cre workflow simulate markets --target {{TARGET}}

# Simulate Market Creation (dry run; response uses payload data when chain read is stale). Payload path relative to sub0cre.
sim-create *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/create-market-payload.json --target {{TARGET}} {{args}}

# Create market and actually send txs to the deployed contract (requires CRE_ETH_PRIVATE_KEY and --broadcast).
sim-create-broadcast:
    just sim-create --broadcast

# Simulate Get Market by questionId
sim-get-market *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/get-market-payload.json --target {{TARGET}} {{args}}

# Simulate Resolve Market (Sub0 CRE 0x01; oracle must match market)
sim-resolve *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/resolve-market-payload.json --target {{TARGET}} {{args}}

# Simulate Stake (Sub0 CRE 0x02; forwarder stakes on behalf of owner)
sim-stake *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/stake-payload.json --target {{TARGET}} {{args}}

# Simulate Redeem (Sub0 CRE 0x03; owner must supply EIP-712 signature)
sim-redeem *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/redeem-payload.json --target {{TARGET}} {{args}}

# Simulate Liquidity Seeding (append --broadcast to execute on-chain)
sim-seed *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/seed-payload.json --target {{TARGET}} {{args}}

# Simulate Quote signing (DON signs LMSR quote; use same questionId as created market)
sim-quote *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/quote-payload.json --target {{TARGET}} {{args}}

# Simulate Order (buy or sell; same handler as quote, returns signed quote)
sim-order *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/buy-payload.json --target {{TARGET}} {{args}}

# Simulate Buy order (order with buy: true)
sim-buy *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/buy-payload.json --target {{TARGET}} {{args}}

# Simulate Sell order (order with buy: false)
sim-sell *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/sell-payload.json --target {{TARGET}} {{args}}

# Simulate Create Agent Key (generates key in enclave, returns address)
sim-create-agent-key *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/create-agent-key-payload.json --target {{TARGET}} {{args}}

# Simulate LMSR Pricing Engine (DON computes cost and signs quote)
sim-lmsr *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/lmsr-pricing-payload.json --target {{TARGET}} {{args}}

# Simulate Confidential Compute Trade Execution (standalone workflow)
sim-confidential *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/execute-confidential-trade-payload.json --target {{TARGET}} {{args}}

# Run agent market creation: fetch from backend, create each on-chain, callback onchain-created (requires backend running and BACKEND_API_KEY in secrets).
sim-create-markets-from-backend *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/create-markets-from-backend-payload.json --target {{TARGET}} {{args}}

# Simulate ERC20 approve (signer: backend or agent; returns signed tx for broadcast)
sim-approve-erc20 *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/approve-erc20-payload.json --target {{TARGET}} {{args}}

# Simulate ERC20 approve using agent key (set agentId in payload)
sim-approve-erc20-agent *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/approve-erc20-agent-payload.json --target {{TARGET}} {{args}}

# Simulate conditional token setApprovalForAll (signer: backend or agent; returns signed tx)
sim-approve-conditional-token *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/approve-conditional-token-payload.json --target {{TARGET}} {{args}}

# Simulate conditional token approve using agent key
sim-approve-conditional-token-agent *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/approve-conditional-token-agent-payload.json --target {{TARGET}} {{args}}

# Deploy the workflow to the Chainlink registry
deploy:
    cre workflow deploy markets --target {{TARGET}}

# Deploy to Celo Sepolia testnet (uses config.celo.json)
deploy-celo:
    cre workflow deploy markets --target celo-settings

# Activate the deployed workflow on the DON
activate:
    cre workflow activate markets --target {{TARGET}}

# Activate on Celo Alfajores
activate-celo:
    cre workflow activate markets --target celo-settings

# Simulate the celo workflow logic using staging chain (Sepolia).
# NOTE: CRE simulator does not support Celo Sepolia chain ID (11142220).
# Use staging-settings for simulation; celo-settings is only for deploy/activate on DON.
sim-celo *args:
    cre workflow simulate markets --target staging-settings {{args}}

# ── New Autonomous Workflows ─────────────────────────────────────────────────

# Install dependencies for all new workflows
install-all:
    bun install --cwd ./markets
    bun install --cwd ./market-discovery
    bun install --cwd ./agent-analysis
    bun install --cwd ./settlement-consensus
    bun install --cwd ./confidential-trade
    bun install --cwd ./registry-sync

# Simulate market-discovery workflow (cron: autonomous market creation)
sim-discovery *args:
    cre workflow simulate market-discovery --target {{TARGET}} {{args}}

# Simulate market-discovery via HTTP trigger (manual run)
sim-discovery-http *args:
    cre workflow simulate market-discovery --non-interactive --trigger-index 1 --http-payload @../payloads/market-discovery-run-payload.json --target {{TARGET}} {{args}}

# Simulate agent-analysis workflow (cron: LLM trading analysis batch)
sim-analysis *args:
    cre workflow simulate agent-analysis --target {{TARGET}} {{args}}

# Simulate agent-analysis via HTTP trigger (single agent+market pair)
sim-analysis-http *args:
    cre workflow simulate agent-analysis --non-interactive --trigger-index 1 --http-payload @../payloads/agent-analysis-run-payload.json --target {{TARGET}} {{args}}

# Simulate settlement-consensus workflow (HTTP: two-agent LLM deliberation)
sim-settlement *args:
    cre workflow simulate settlement-consensus --non-interactive --trigger-index 1 --http-payload @../payloads/run-settlement-payload.json --target {{TARGET}} {{args}}

# Simulate confidential-trade standalone workflow
sim-confidential-trade *args:
    cre workflow simulate confidential-trade --non-interactive --trigger-index 1 --http-payload @../payloads/execute-confidential-trade-payload.json --target {{TARGET}} {{args}}

# Simulate registry-sync workflow (cron: keep Postgres cache in sync)
sim-registry-sync *args:
    cre workflow simulate registry-sync --target {{TARGET}} {{args}}

# Simulate cross-chain-sync workflow (CCIP broadcast)
sim-cross-chain *args:
    cre workflow simulate cross-chain-sync --target {{TARGET}} {{args}}

# Simulate compliance-guard workflow (ACE policy check)
sim-compliance *args:
    cre workflow simulate compliance-guard --non-interactive --trigger-index 1 --http-payload @../payloads/compliance-check-payload.json --target {{TARGET}} {{args}}

# Deploy all workflows to the Chainlink registry
deploy-all:
    just deploy
    cre workflow deploy market-discovery --target {{TARGET}}
    cre workflow deploy agent-analysis --target {{TARGET}}
    cre workflow deploy settlement-consensus --target {{TARGET}}
    cre workflow deploy confidential-trade --target {{TARGET}}
    cre workflow deploy registry-sync --target {{TARGET}}
    cre workflow deploy cross-chain-sync --target {{TARGET}}
    cre workflow deploy compliance-guard --target {{TARGET}}

# Activate all deployed workflows on the DON
activate-all:
    cre workflow activate markets --target {{TARGET}}
    cre workflow activate market-discovery --target {{TARGET}}
    cre workflow activate agent-analysis --target {{TARGET}}
    cre workflow activate settlement-consensus --target {{TARGET}}
    cre workflow activate confidential-trade --target {{TARGET}}
    cre workflow activate registry-sync --target {{TARGET}}
    cre workflow activate cross-chain-sync --target {{TARGET}}
    cre workflow activate compliance-guard --target {{TARGET}}

# Helper: Authenticate with the CRE CLI
login:
    cre login
    
# Run gateway with Infisical. Use CRE_USE_VOLUME_AUTH=true so CLI uses mounted ~/.cre from 'cre login'
# instead of CRE_API_KEY from Infisical (avoids "invalid token" when that key is wrong or unused).
# Default chain: Sepolia (config.docker.json)
docker *args:
  docker run --rm --name sub0cre-gateway -p 8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  -e CRE_TARGET=docker-settings \
  -e CRE_USE_VOLUME_AUTH=true \
  -e INFISICAL_TOKEN="st.7d11119f-45f6-4ec6-bd97-170b52ce5aee.da6f5dbd8fcdcdd3997e72ac36aee4fe.3f743af3cbd3f5e11b7dadaa097b808c" \
  -v "$(pwd)/markets/config.docker.json:/config/cre.json" \
  -e CRE_CONFIG_FILE=/config/cre.json \
  -v "$HOME/.cre:/root/.cre" \
  sub0cre-gateway {{args}}

# Run gateway targeting Celo Sepolia (config.celo.json).
# NOTE: CRE EVM simulation does not support Celo chain ID (11142220) — EVM actions are
# skipped in simulation mode. HTTP callbacks to the backend work normally.
docker-celo *args:
  docker run --rm --name sub0cre-gateway-celo -p 8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  -e CRE_TARGET=docker-settings \
  -e CRE_USE_VOLUME_AUTH=true \
  -e INFISICAL_TOKEN="st.7d11119f-45f6-4ec6-bd97-170b52ce5aee.da6f5dbd8fcdcdd3997e72ac36aee4fe.3f743af3cbd3f5e11b7dadaa097b808c" \
  -v "$(pwd)/markets/config.celo.json:/config/cre.json" \
  -e CRE_CONFIG_FILE=/config/cre.json \
  -v "$HOME/.cre:/root/.cre" \
  sub0cre-gateway {{args}}

# Re-authenticate CRE CLI inside Docker so credentials refresh in the host's ~/.cre via volume mount.
# Port 53682 is exposed for the OAuth callback — open the printed URL in your browser to complete login.
# After login, the refreshed ~/.cre is available on the host. Restart 'just docker' to pick it up.
docker-login:
  @echo "Starting temporary CRE login container (OAuth callback on localhost:53682)..."
  docker run -d --rm --name sub0cre-login-tmp \
    -p 53682:53682 \
    -v "$HOME/.cre:/root/.cre" \
    sub0cre-gateway sleep infinity
  docker exec -it sub0cre-login-tmp cre login || true
  docker rm -f sub0cre-login-tmp 2>/dev/null || true
  @echo "Done. Credentials saved to ~/.cre — restart 'just docker' to apply."

# ── Docker build targets ───────────────────────────────────────────────────

# Build for LOCAL use (no credentials baked in; just docker mounts ~/.cre as volume)
docker-build:
  docker build --target base -t sub0cre-gateway .

# Build with credentials baked in (for cloud deploy: Cloud Run, Render, etc.)
# Creates cre.zip from ~/.cre first, then does a full image build.
# DO NOT commit cre.zip — it contains private keys.
docker-build-cloud:
  (cd $HOME && zip -r {{justfile_directory()}}/cre.zip .cre) && \
  docker build -t sub0cre-gateway . && \
  rm -f cre.zip && \
  echo "Cloud image built and cre.zip removed."

# Create cre.zip only (for manual upload to Cloud Run Secret Manager)
# set CRE_CREDENTIALS_PATH to the secret mount path (e.g. /secrets/cre.zip)
docker-cre-zip:
  (cd $HOME && zip -r {{justfile_directory()}}/cre.zip .cre) && echo "Created cre.zip - upload to Secret Manager and set CRE_CREDENTIALS_PATH in Cloud Run. Remove locally after upload."