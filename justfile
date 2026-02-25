# Set the default CRE target environment
TARGET := "staging-settings"

# Default command when typing just `just`
default:
    @just --list


# Install dependencies and setup the WASM toolchain (run from sub0cre; includes cre-setup in markets)
install:
    bun install --cwd ./markets

# Build workflow to WASM so CRE CLI can run simulate (avoids "no such file or directory" for .cre_build_tmp.wasm).
# Run from sub0cre. Tries cre-compile; if .cre_build_tmp.wasm is missing, copies main.wasm so simulate can run.
build-workflow:
    cd markets && bun x cre-compile main.ts .cre_build_tmp.wasm || true
    cd markets && test -f .cre_build_tmp.wasm || cp -f main.wasm .cre_build_tmp.wasm

# Run the interactive workflow simulation (build-workflow recommended first if simulate fails)
sim:
    cre workflow simulate markets --target {{TARGET}}

# Simulate Market Creation (dry run; response uses payload data when chain read is stale). Payload path relative to sub0cre.
sim-create *args:
    just build-workflow
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @payloads/create-market-payload.json --target {{TARGET}} {{args}}

# Create market and actually send txs to the deployed contract (requires CRE_ETH_PRIVATE_KEY and --broadcast).
sim-create-broadcast:
    just sim-create --broadcast

# Simulate Get Market by questionId
sim-get-market *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/get-market-payload.json --target {{TARGET}} {{args}}

# Simulate Liquidity Seeding (append --broadcast to execute on-chain)
sim-seed *args:
    just build-workflow
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @payloads/seed-payload.json --target {{TARGET}} {{args}}

# Simulate LMSR Pricing Engine
sim-lmsr *args:
    just build-workflow
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @payloads/lmsr-pricing-payload.json --target {{TARGET}} {{args}}

# Simulate Confidential Compute Trade Execution
sim-confidential *args:
    just build-workflow
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @payloads/execute-confidential-trade-payload.json --target {{TARGET}} {{args}}

# Run agent market creation: fetch from backend, create each on-chain, callback onchain-created (requires backend running and BACKEND_API_KEY in secrets).
sim-create-markets-from-backend *args:
    just build-workflow
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @payloads/create-markets-from-backend-payload.json --target {{TARGET}} {{args}}

# Deploy the workflow to the Chainlink registry
deploy:
    cre workflow deploy markets --target {{TARGET}}

# Activate the deployed workflow on the DON
activate:
    cre workflow activate markets --target {{TARGET}}

# Helper: Authenticate with the CRE CLI
login:
    cre login